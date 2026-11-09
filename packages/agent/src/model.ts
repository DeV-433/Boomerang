import { createHash } from "node:crypto";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { and, desc, eq, sql } from "drizzle-orm";
import { modelCalls, type Database } from "@boomerang/db";

/**
 * The only module that talks to the model provider (Gemini). Lint rule: only packages/agent may
 * import @google/genai, and the policy gate and audit writer may not import this package at all.
 *
 * No call ever passes tools. The model returns JSON that code validates; it cannot act.
 */

export type CallKind = "decide" | "draft" | "classify";

export interface ModelRequest {
  kind: CallKind;
  model: string;
  promptVersion: string;
  system: string;
  input: string;
  /** JSON schema the response must follow (Gemini structured output). */
  jsonSchema: Record<string, unknown>;
  thinking: "MINIMAL" | "LOW";
  caseId?: string | null;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
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
 * USD per 1M tokens, Standard paid tier, from https://aistudio.google.com/docs/pricing (read
 * 2026-11-09). Thinking tokens are billed as output. Gemini 3.8 Flash doubles on 2027-01-01.
 */
export const PRICES: Record<string, { input: number; output: number; note?: string }> = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75, note: "until 2026-12-31; $1.50 / $7.50 from 2027-01-01" },
  "gemini-3.6-flash": { input: 0.75, output: 3.75, note: "until 2026-12-31; $1.50 / $7.50 from 2027-01-01" },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
};

/**
 * Model choice, measured 2026-11-09: gemini-3.8-flash was overloaded (503 "high demand", or no
 * answer in 45 s) and rejects thinking level MINIMAL; gemini-3.6-flash answered a decision in
 * about 1.8 s and gemini-3.5-flash-lite in about 0.9 s. Each call falls back to FALLBACK_MODEL
 * when its primary is unavailable or slow.
 */
export const DECISION_MODEL = "gemini-3.6-flash";
export const DRAFT_MODEL = "gemini-3.5-flash-lite";
export const CLASSIFY_MODEL = "gemini-3.5-flash-lite";
export const FALLBACK_MODEL = "gemini-3.5-flash-lite";
/** A call that has not answered by now is abandoned and retried (or sent to the fallback model). */
export const CALL_TIMEOUT_MS = 20_000;

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

/**
 * Gemini through @google/genai. Each call has a hard timeout. Overload (429, 503), server errors
 * and timeouts are retried once on the requested model, then sent to the fallback model.
 */
export class GeminiClient implements ModelClient {
  private readonly ai: GoogleGenAI;
  constructor(
    apiKey: string,
    private readonly options: {
      fallbackModel?: string | null;
      timeoutMs?: number;
      attemptsPerModel?: number;
      /** Requests per minute allowed per model; calls queue to stay under it (GEMINI_RPM). */
      rpm?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /** Per-model time of the next free request slot, for client-side rate limiting. */
  private readonly nextSlot = new Map<string, number>();

  private async throttle(model: string): Promise<void> {
    const rpm = this.options.rpm;
    if (!rpm) return;
    const gap = 60_000 / rpm;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(model) ?? 0);
    this.nextSlot.set(model, slot + gap);
    if (slot > now) await (this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(slot - now);
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const fallback = this.options.fallbackModel === undefined ? FALLBACK_MODEL : this.options.fallbackModel;
    const models = [req.model, ...(fallback && fallback !== req.model ? [fallback] : [])];
    const attemptsPerModel = this.options.attemptsPerModel ?? 2;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let lastError: ModelCallError | null = null;
    for (const model of models) {
      let rateLimitWaits = 0;
      for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
        try {
          await this.throttle(model);
          return await this.once(model, req);
        } catch (error) {
          lastError = error instanceof ModelCallError ? error : new ModelCallError(String(error), true);
          if (!lastError.retryable) throw lastError;
          // A per-minute rate limit says when to come back: wait that long (up to 3 times, 60 s each)
          // and try the same model again without using up an attempt.
          if (lastError.retryAfterMs !== null && rateLimitWaits < 3) {
            rateLimitWaits++;
            attempt--;
            await sleep(Math.min(60_000, lastError.retryAfterMs) + 250);
            continue;
          }
          if (attempt < attemptsPerModel) await sleep(800 * attempt + Math.floor(Math.random() * 200));
        }
      }
    }
    throw lastError ?? new ModelCallError("no model answered", true);
  }

  private async once(model: string, req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    try {
      const res = await this.ai.models.generateContent({
        model,
        contents: req.input,
        config: {
          systemInstruction: req.system,
          temperature: 0,
          responseMimeType: "application/json",
          responseJsonSchema: req.jsonSchema,
          thinkingConfig: { thinkingLevel: req.thinking === "LOW" ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL },
          abortSignal: AbortSignal.timeout(this.options.timeoutMs ?? CALL_TIMEOUT_MS),
          // Deliberately no `tools`: the model can only answer, never act.
        },
      });
      const u = res.usageMetadata ?? {};
      return {
        model,
        text: res.text ?? "",
        usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0, thinkingTokens: u.thoughtsTokenCount ?? 0 },
        latencyMs: Date.now() - started,
        cached: false,
      };
    } catch (error) {
      const e = error as { status?: number; name?: string; message?: string };
      const timedOut = e.name === "TimeoutError" || e.name === "AbortError" || /abort|timed? ?out/i.test(e.message ?? "");
      const status = e.status ?? (/"code":\s*(\d{3})/.exec(e.message ?? "")?.[1] ? Number(/"code":\s*(\d{3})/.exec(e.message ?? "")![1]) : undefined);
      const retryable = timedOut || status === undefined || status === 429 || status >= 500;
      // Gemini's 429 body carries "retryDelay": "12s" (or "12.5s") for per-minute limits.
      const delay = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(e.message ?? "");
      const retryAfterMs = status === 429 ? (delay ? Math.ceil(Number(delay[1]) * 1000) : 15_000) : null;
      throw new ModelCallError(`${model} ${req.kind} ${timedOut ? "timed out" : `failed (${status ?? "no status"})`}: ${(e.message ?? "").slice(0, 200)}`, retryable, retryAfterMs);
    }
  }
}

export function requestHash(req: ModelRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([req.kind, req.model, req.promptVersion, req.system, req.input, req.jsonSchema, req.thinking]))
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
        .where(and(eq(modelCalls.kind, req.kind), eq(modelCalls.inputHash, hash), sql`${modelCalls.error} is null`))
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
