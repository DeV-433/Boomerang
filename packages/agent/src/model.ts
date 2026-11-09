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
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
};

export const DECISION_MODEL = "gemini-3.8-flash";
export const DRAFT_MODEL = "gemini-3.8-flash";
export const CLASSIFY_MODEL = "gemini-3.5-flash-lite";

export function costUsd(model: string, usage: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (usage.inputTokens * p.input + (usage.outputTokens + usage.thinkingTokens) * p.output) / 1_000_000;
}

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

/** Gemini through @google/genai, with backoff on rate limits and server errors. */
export class GeminiClient implements ModelClient {
  private readonly ai: GoogleGenAI;
  constructor(
    apiKey: string,
    private readonly options: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const maxAttempts = this.options.maxAttempts ?? 4;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      try {
        const res = await this.ai.models.generateContent({
          model: req.model,
          contents: req.input,
          config: {
            systemInstruction: req.system,
            temperature: 0,
            responseMimeType: "application/json",
            responseJsonSchema: req.jsonSchema,
            thinkingConfig: { thinkingLevel: req.thinking === "LOW" ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL },
            // Deliberately no `tools`: the model can only answer, never act.
          },
        });
        const u = res.usageMetadata ?? {};
        return {
          text: res.text ?? "",
          usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0, thinkingTokens: u.thoughtsTokenCount ?? 0 },
          latencyMs: Date.now() - started,
          cached: false,
        };
      } catch (error) {
        const status = (error as { status?: number }).status;
        const retryable = status === 429 || (status !== undefined && status >= 500) || status === undefined;
        if (!retryable || attempt >= maxAttempts) throw new ModelCallError(`${req.model} ${req.kind} failed: ${(error as Error).message.slice(0, 300)}`, retryable);
        await sleep(Math.min(16_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
      }
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
        .where(and(eq(modelCalls.kind, req.kind), eq(modelCalls.model, req.model), eq(modelCalls.inputHash, hash), sql`${modelCalls.error} is null`))
        .orderBy(desc(modelCalls.createdAt))
        .limit(1);
      if (hit?.responseText) {
        const usage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
        meter?.record({ kind: req.kind, model: req.model, usage, costUsd: 0, cached: true });
        return { text: hit.responseText, usage, latencyMs: 0, cached: true };
      }
    }
    try {
      const res = await this.inner.generate(req);
      const cost = costUsd(req.model, res.usage);
      meter?.record({ kind: req.kind, model: req.model, usage: res.usage, costUsd: cost, cached: false });
      await db?.insert(modelCalls).values({
        kind: req.kind,
        model: req.model,
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
