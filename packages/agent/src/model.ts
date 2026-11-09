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
 * Overload, server errors and timeouts are retried once, then sent to the fallback model. Calls are
 * paced to stay under the per-minute token budget Groq reports in its headers, and under GROQ_RPM.
 *
 * Several keys (from separate Groq organizations; limits are per organization) can be given. Calls
 * rotate across them; a key that hits a limit (429) is set aside for that model until Groq says it
 * resets, and the call moves to the next key at once. Only when every key is limited does the call
 * wait (per-minute limits, up to 60 s) or give up on that model (daily limits).
 */
export class GroqClient implements ModelClient {
  /** Per model, the latest limits Groq reported (any key). Exposed so evals can print real limits. */
  readonly limits = new Map<string, LimitState>();
  /** Per key and model ("0|openai/gpt-oss-120b"). */
  private readonly keyLimits = new Map<string, LimitState>();
  private readonly blockedUntil = new Map<string, number>();
  private readonly nextSlot = new Map<string, number>();
  private readonly keys: string[];
  private turn = 0;

  constructor(
    apiKeys: string | readonly string[],
    private readonly options: {
      fallbackModel?: string | null;
      timeoutMs?: number;
      attemptsPerModel?: number;
      /** Requests per minute allowed per key and model; calls queue to stay under it (GROQ_RPM). */
      rpm?: number;
      fetchFn?: FetchLike;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      /** Told when a key is set aside (index only, never the key). */
      onKeyLimited?: (info: { keyIndex: number; model: string; untilMs: number; reason: string }) => void;
    } = {},
  ) {
    this.keys = [
      ...new Set((typeof apiKeys === "string" ? [apiKeys] : apiKeys).map((k) => k.trim()).filter(Boolean)),
    ];
    if (this.keys.length === 0) throw new Error("GroqClient needs at least one API key");
  }

  get keyCount(): number {
    return this.keys.length;
  }

  /** Time an injected (test) sleep has skipped, so the client's clock still moves past a wait. */
  private skippedMs = 0;

  private now(): number {
    return (this.options.now ?? Date.now)() + this.skippedMs;
  }

  private async sleep(ms: number): Promise<void> {
    if (!this.options.sleep) return new Promise((r) => setTimeout(r, ms));
    await this.options.sleep(ms);
    if (!this.options.now) this.skippedMs += ms;
  }

  /**
   * Picks the key for the next call to a model: round-robin over keys that are not set aside,
   * preferring one with token budget left this minute. Returns the wait (ms) if every key is set aside.
   */
  private pickKey(model: string, estimatedTokens: number): { key: number } | { waitMs: number } {
    const now = this.now();
    const open: number[] = [];
    for (let i = 0; i < this.keys.length; i++) {
      const k = (this.turn + i) % this.keys.length;
      if ((this.blockedUntil.get(`${k}|${model}`) ?? 0) <= now) open.push(k);
    }
    if (open.length === 0) {
      const soonest = Math.min(...this.keys.map((_, k) => this.blockedUntil.get(`${k}|${model}`) ?? now));
      return { waitMs: Math.max(0, soonest - now) };
    }
    const hasBudget = (k: number) => {
      const st = this.keyLimits.get(`${k}|${model}`);
      if (!st || st.remainingTokens === null || st.resetTokensMs === null) return true;
      return st.remainingTokens >= estimatedTokens || st.seenAt + st.resetTokensMs <= now;
    };
    const key = open.find(hasBudget) ?? open[0]!;
    this.turn = (key + 1) % this.keys.length;
    return { key };
  }

  /** Waits for the key's next request slot (GROQ_RPM) and for its token budget (x-ratelimit-remaining-tokens). */
  private async pace(key: number, model: string, estimatedTokens: number): Promise<void> {
    const id = `${key}|${model}`;
    const rpm = this.options.rpm;
    if (rpm) {
      const now = this.now();
      const slot = Math.max(now, this.nextSlot.get(id) ?? 0);
      this.nextSlot.set(id, slot + 60_000 / rpm);
      if (slot > now) await this.sleep(slot - now);
    }
    const state = this.keyLimits.get(id);
    if (
      state &&
      state.remainingTokens !== null &&
      state.resetTokensMs !== null &&
      state.remainingTokens < estimatedTokens
    ) {
      const wait = state.seenAt + state.resetTokensMs - this.now();
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
      let failures = 0;
      let allLimitedWaits = 0;
      // Bounded: each pass either sets a key aside, counts a failure, or counts a wait.
      for (
        let pass = 0;
        pass < this.keys.length + attemptsPerModel + 3 && failures < attemptsPerModel;
        pass++
      ) {
        const pick = this.pickKey(model, estimate);
        if ("waitMs" in pick) {
          // Every key is limited for this model: wait only for a short (per-minute) reset.
          if (pick.waitMs > 60_000 || allLimitedWaits >= 3) break;
          allLimitedWaits++;
          await this.sleep(pick.waitMs);
          continue;
        }
        try {
          await this.pace(pick.key, model, estimate);
          return await this.once(pick.key, model, req);
        } catch (error) {
          lastError = error instanceof ModelCallError ? error : new ModelCallError(String(error), true);
          if (!lastError.retryable) throw lastError;
          if (lastError.retryAfterMs !== null) {
            // 429: set this key aside for this model until Groq says it resets, and move on.
            const untilMs = this.now() + lastError.retryAfterMs + 250;
            this.blockedUntil.set(`${pick.key}|${model}`, untilMs);
            this.options.onKeyLimited?.({
              keyIndex: pick.key,
              model,
              untilMs,
              reason: /per day|TPD|RPD/.test(lastError.message) ? "daily" : "per-minute",
            });
            continue;
          }
          failures++;
          if (failures < attemptsPerModel) await this.sleep(800 * failures + Math.floor(Math.random() * 200));
        }
      }
    }
    throw lastError ?? new ModelCallError("no model answered", true);
  }

  private async once(key: number, model: string, req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    let res: Response;
    try {
      res = await (this.options.fetchFn ?? fetch)(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.keys[key]}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.input },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: req.kind, strict: true, schema: req.jsonSchema },
          },
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
      throw new ModelCallError(
        `${model} ${req.kind} ${timedOut ? "timed out" : `network error: ${e.message}`}`,
        true,
      );
    }

    const state: LimitState = {
      limitTokensPerMinute: numberHeader(res, "x-ratelimit-limit-tokens"),
      remainingTokens: numberHeader(res, "x-ratelimit-remaining-tokens"),
      resetTokensMs: parseDuration(res.headers.get("x-ratelimit-reset-tokens")),
      limitRequestsPerDay: numberHeader(res, "x-ratelimit-limit-requests"),
      remainingRequestsToday: numberHeader(res, "x-ratelimit-remaining-requests"),
      seenAt: this.now(),
    };
    this.limits.set(model, state);
    this.keyLimits.set(`${key}|${model}`, state);

    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      const retryAfterMs =
        res.status === 429
          ? (parseDuration(res.headers.get("retry-after")) ??
            parseDuration(res.headers.get("x-ratelimit-reset-tokens")) ??
            15_000)
          : null;
      // json_validate_failed: Groq's own strict-mode check rejected this sample. Generation is random, so another try can pass.
      const retryable = res.status === 429 || res.status >= 500 || body.includes('"json_validate_failed"');
      const who = this.keys.length > 1 ? ` [key ${key + 1}/${this.keys.length}]` : "";
      throw new ModelCallError(
        `${model} ${req.kind} failed (${res.status})${who}: ${body}`,
        retryable,
        retryAfterMs,
      );
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
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
    .update(
      JSON.stringify([
        req.kind,
        req.model,
        req.promptVersion,
        req.system,
        req.input,
        req.jsonSchema,
        req.reasoning,
      ]),
    )
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
    return {
      all: sum(this.calls),
      byKind: Object.fromEntries(kinds.map((k) => [k, sum(this.calls.filter((c) => c.kind === k))])),
    };
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
        .where(
          and(
            eq(modelCalls.kind, req.kind),
            eq(modelCalls.inputHash, hash),
            eq(modelCalls.model, req.model),
            sql`${modelCalls.error} is null`,
          ),
        )
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
      .where(
        and(
          eq(modelCalls.kind, req.kind),
          eq(modelCalls.inputHash, requestHash(req)),
          sql`${modelCalls.valid} is null`,
        ),
      );
  }
}
