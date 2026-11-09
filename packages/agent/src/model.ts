import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { modelCalls, type Database } from "@boomerang/db";

/**
 * The only module that talks to the model provider (Groq). Lint rules keep provider SDKs and the
 * Groq endpoint inside packages/agent, and the policy gate and audit writer may not import this
 * package at all.
 *
 * No call ever passes tools. The model returns schema-constrained JSON that code validates again;
 * it cannot act.
 */

export type CallKind = "decide" | "draft" | "classify";

export interface ModelRequest {
  kind: CallKind;
  model: string;
  promptVersion: string;
  system: string;
  input: string;
  /** JSON schema the response must follow (Groq strict structured outputs). */
  jsonSchema: Record<string, unknown>;
  /** Reasoning effort for reasoning models (gpt-oss). */
  reasoning: "low" | "medium";
  caseId?: string | null;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Reasoning tokens, billed as output. */
  thinkingTokens: number;
}

export interface ModelResponse {
  /** The model that actually answered (the fallback, if the primary was unavailable). */
  model: string;
  text: string;
  usage: Usage;
  latencyMs: number;
  /** True when served from the model_calls cache: no tokens spent. */
  cached: boolean;
}

export interface ModelClient {
  generate(req: ModelRequest): Promise<ModelResponse>;
}

/**
 * USD per 1M tokens, from Groq's model pages (console.groq.com/docs/model/..., read 2026-11-09).
 * Reasoning tokens count as output.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
  "openai/gpt-oss-20b": { input: 0.075, output: 0.3 },
};

/**
 * Model choice (2026-11-09): of Groq's production models, only gpt-oss-120b and gpt-oss-20b
 * support strict JSON-schema outputs (constrained decoding). The larger model makes the decision and
 * classifies replies (it reads untrusted customer text; 20B fell for an injection in the eval). The
 * faster, cheaper one drafts the personal note, which also spreads load across two per-model rate
 * limits. Each call falls back to FALLBACK_MODEL if its primary fails.
 */
export const DECISION_MODEL = "openai/gpt-oss-120b";
export const DRAFT_MODEL = "openai/gpt-oss-20b";
export const CLASSIFY_MODEL = "openai/gpt-oss-120b";
export const FALLBACK_MODEL = "openai/gpt-oss-20b";
/** A call that has not answered by now is abandoned and retried (or sent to the fallback model). */
export const CALL_TIMEOUT_MS = 30_000;
export const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export function costUsd(model: string, usage: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (usage.inputTokens * p.input + (usage.outputTokens + usage.thinkingTokens) * p.output) / 1_000_000;
}

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** Set for rate limits: how long the provider asked us to wait. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

/** Parses Groq's durations such as "7.66s", "1m2.5s", "120ms" or a plain number of seconds into milliseconds. */
export function parseDuration(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.ceil(seconds * 1000);
  let ms = 0;
  let matched = false;
  for (const [, n, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    ms += Number(n) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1);
  }
  return matched ? Math.ceil(ms) : null;
}

/** Latest rate-limit state Groq reported for a model (x-ratelimit-* headers). */
export interface LimitState {
  limitTokensPerMinute: number | null;
  remainingTokens: number | null;
  resetTokensMs: number | null;
  limitRequestsPerDay: number | null;
  remainingRequestsToday: number | null;
  seenAt: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Groq's OpenAI-compatible chat completions API, called with fetch. Each call has a hard timeout.
 * Rate limits (429) wait for Groq's retry-after; overload, server errors and timeouts are retried
 * once, then sent to the fallback model. Calls are also paced to stay under the per-minute token
 * budget Groq reports in its headers, and under GROQ_RPM if set.
 */
export class GroqClient implements ModelClient {
  /** Per model, the latest limits Groq reported. Exposed so evals can print the account's real limits. */
  readonly limits = new Map<string, LimitState>();
  private readonly nextSlot = new Map<string, number>();

  constructor(
    private readonly apiKey: string,
    private readonly options: {
      fallbackModel?: string | null;
      timeoutMs?: number;
      attemptsPerModel?: number;
      /** Requests per minute allowed per model; calls queue to stay under it (GROQ_RPM). */
      rpm?: number;
      fetchFn?: FetchLike;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  private sleep(ms: number): Promise<void> {
    return (this.options.sleep ?? ((t: number) => new Promise((r) => setTimeout(r, t))))(ms);
  }

  /** Waits for the next request slot (GROQ_RPM) and for token budget (x-ratelimit-remaining-tokens). */
  private async pace(model: string, estimatedTokens: number): Promise<void> {
    const rpm = this.options.rpm;
    if (rpm) {
      const now = Date.now();
      const slot = Math.max(now, this.nextSlot.get(model) ?? 0);
      this.nextSlot.set(model, slot + 60_000 / rpm);
      if (slot > now) await this.sleep(slot - now);
    }
    const state = this.limits.get(model);
    if (state && state.remainingTokens !== null && state.resetTokensMs !== null && state.remainingTokens < estimatedTokens) {
      const wait = state.seenAt + state.resetTokensMs - Date.now();
      if (wait > 0) await this.sleep(Math.min(wait, 60_000) + 100);
    }
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const fallback = this.options.fallbackModel === undefined ? FALLBACK_MODEL : this.options.fallbackModel;
    const models = [req.model, ...(fallback && fallback !== req.model ? [fallback] : [])];
    const attemptsPerModel = this.options.attemptsPerModel ?? 2;
    const estimate = Math.ceil((req.system.length + req.input.length) / 3.5) + 600;
    let lastError: ModelCallError | null = null;
    for (const model of models) {
      let rateLimitWaits = 0;
      for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
        try {
          await this.pace(model, estimate);
          return await this.once(model, req);
        } catch (error) {
          lastError = error instanceof ModelCallError ? error : new ModelCallError(String(error), true);
          if (!lastError.retryable) throw lastError;
          // A per-minute limit says when to come back: wait (up to 3 times, 60 s each) on the same model.
          if (lastError.retryAfterMs !== null && rateLimitWaits < 3 && lastError.retryAfterMs <= 60_000) {
            rateLimitWaits++;
            attempt--;
            await this.sleep(lastError.retryAfterMs + 250);
            continue;
          }
          if (attempt < attemptsPerModel) await this.sleep(800 * attempt + Math.floor(Math.random() * 200));
        }
      }
    }
    throw lastError ?? new ModelCallError("no model answered", true);
  }

  private async once(model: string, req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    let res: Response;
    try {
      res = await (this.options.fetchFn ?? fetch)(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.input },
          ],
          response_format: { type: "json_schema", json_schema: { name: req.kind, strict: true, schema: req.jsonSchema } },
          reasoning_effort: req.reasoning,
          include_reasoning: false,
          max_completion_tokens: 2048,
          // Deliberately no `tools`: the model can only answer, never act.
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? CALL_TIMEOUT_MS),
      });
    } catch (error) {
      const e = error as Error;
      const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
      throw new ModelCallError(`${model} ${req.kind} ${timedOut ? "timed out" : `network error: ${e.message}`}`, true);
    }

    this.limits.set(model, {
      limitTokensPerMinute: numberHeader(res, "x-ratelimit-limit-tokens"),
      remainingTokens: numberHeader(res, "x-ratelimit-remaining-tokens"),
      resetTokensMs: parseDuration(res.headers.get("x-ratelimit-reset-tokens")),
      limitRequestsPerDay: numberHeader(res, "x-ratelimit-limit-requests"),
      remainingRequestsToday: numberHeader(res, "x-ratelimit-remaining-requests"),
      seenAt: Date.now(),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      const retryAfterMs =
        res.status === 429 ? (parseDuration(res.headers.get("retry-after")) ?? parseDuration(res.headers.get("x-ratelimit-reset-tokens")) ?? 15_000) : null;
      // json_validate_failed: Groq's own strict-mode check rejected this sample. Generation is random, so another try can pass.
      const retryable = res.status === 429 || res.status >= 500 || body.includes('"json_validate_failed"');
      throw new ModelCallError(`${model} ${req.kind} failed (${res.status}): ${body}`, retryable, retryAfterMs);
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const reasoning = json.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    return {
      model,
      text: json.choices?.[0]?.message?.content ?? "",
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: Math.max(0, (json.usage?.completion_tokens ?? 0) - reasoning),
        thinkingTokens: reasoning,
      },
      latencyMs: Date.now() - started,
      cached: false,
    };
  }
}

function numberHeader(res: Response, name: string): number | null {
  const v = res.headers.get(name);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function requestHash(req: ModelRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([req.kind, req.model, req.promptVersion, req.system, req.input, req.jsonSchema, req.reasoning]))
    .digest("hex");
}

export interface CallRecord {
  kind: CallKind;
  model: string;
  usage: Usage;
  costUsd: number;
  cached: boolean;
}

/** Totals for one run: tokens and dollars by call kind (5.11). */
export class UsageMeter {
  readonly calls: CallRecord[] = [];
  record(r: CallRecord): void {
    this.calls.push(r);
  }
  get totals() {
    const sum = (rs: CallRecord[]) => ({
      calls: rs.length,
      cachedCalls: rs.filter((r) => r.cached).length,
      inputTokens: rs.reduce((s, r) => s + r.usage.inputTokens, 0),
      outputTokens: rs.reduce((s, r) => s + r.usage.outputTokens, 0),
      thinkingTokens: rs.reduce((s, r) => s + r.usage.thinkingTokens, 0),
      costUsd: rs.reduce((s, r) => s + r.costUsd, 0),
    });
    const kinds = [...new Set(this.calls.map((c) => c.kind))];
    return { all: sum(this.calls), byKind: Object.fromEntries(kinds.map((k) => [k, sum(this.calls.filter((c) => c.kind === k))])) };
  }
}

/**
 * Records every call in model_calls (5.5, 5.11) and, when `cache` is on, answers a repeated
 * request from the stored response. Simulations use the cache, so a re-run replays the same
 * decisions at no cost; the live loop records but does not cache.
 */
export class RecordingClient implements ModelClient {
  constructor(
    private readonly inner: ModelClient,
    private readonly options: { db?: Database; cache?: boolean; runTag?: string; meter?: UsageMeter } = {},
  ) {}

  get meter(): UsageMeter | undefined {
    return this.options.meter;
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const hash = requestHash(req);
    const { db, meter } = this.options;
    if (db && this.options.cache) {
      const [hit] = await db
        .select()
        .from(modelCalls)
        // Only answers from the requested model: a fallback model's answer is not reused as the primary's.
        .where(and(eq(modelCalls.kind, req.kind), eq(modelCalls.inputHash, hash), eq(modelCalls.model, req.model), sql`${modelCalls.error} is null`))
        .orderBy(desc(modelCalls.createdAt))
        .limit(1);
      if (hit?.responseText) {
        const usage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
        meter?.record({ kind: req.kind, model: hit.model, usage, costUsd: 0, cached: true });
        return { model: hit.model, text: hit.responseText, usage, latencyMs: 0, cached: true };
      }
    }
    try {
      const res = await this.inner.generate(req);
      const cost = costUsd(res.model, res.usage);
      meter?.record({ kind: req.kind, model: res.model, usage: res.usage, costUsd: cost, cached: false });
      await db?.insert(modelCalls).values({
        kind: req.kind,
        model: res.model,
        promptVersion: req.promptVersion,
        inputHash: hash,
        input: { system: req.system, input: req.input },
        responseText: res.text,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        thinkingTokens: res.usage.thinkingTokens,
        costUsd: cost,
        latencyMs: res.latencyMs,
        runTag: this.options.runTag ?? null,
        caseId: req.caseId ?? null,
      });
      return res;
    } catch (error) {
      await db?.insert(modelCalls).values({
        kind: req.kind,
        model: req.model,
        promptVersion: req.promptVersion,
        inputHash: hash,
        input: { system: req.system, input: req.input },
        error: (error as Error).message.slice(0, 500),
        runTag: this.options.runTag ?? null,
        caseId: req.caseId ?? null,
      });
      throw error;
    }
  }

  /** Marks the latest stored response for this request as valid or not, after code has checked it. */
  async markValid(req: ModelRequest, valid: boolean): Promise<void> {
    if (!this.options.db) return;
    await this.options.db
      .update(modelCalls)
      .set({ valid })
      .where(and(eq(modelCalls.kind, req.kind), eq(modelCalls.inputHash, requestHash(req)), sql`${modelCalls.valid} is null`));
  }
}
