import type { Logger } from "@boomerang/core";
import type { TokenManager } from "./auth";
import { errorFromResponse, PayPalHttpError, type FetchLike } from "./http";
import type { IdempotencyStore } from "./idempotency";
import { DEFAULT_RETRY, withRetry, type RetryOptions } from "./retry";
import { runToolkitMethod, toolRegistry } from "./toolkit";
import { assertAllowed, isRestOperation, type Profile } from "./whitelist";

export class InvalidToolArgumentsError extends Error {
  constructor(
    readonly tool: string,
    readonly issues: string[],
  ) {
    super(`Invalid arguments for PayPal tool "${tool}": ${issues.join("; ")}`);
    this.name = "InvalidToolArgumentsError";
  }
}

export class UnknownToolError extends Error {
  constructor(readonly tool: string) {
    super(`PayPal tool "${tool}" does not exist in the installed toolkit`);
    this.name = "UnknownToolError";
  }
}

/** Runs a toolkit method. Swappable in tests. */
export type ToolRunner = typeof runToolkitMethod;

export interface GatewayOptions {
  tokens: TokenManager;
  idempotency: IdempotencyStore;
  logger?: Logger;
  retry?: Partial<RetryOptions>;
  fetchFn?: FetchLike;
  runTool?: ToolRunner;
}

export interface CallOptions {
  /** Required for any call that changes something at PayPal. Sent as PayPal-Request-Id too. */
  idempotencyKey?: string;
}

/** Outcome of a call: `replayed` is true when an earlier call with the same key already succeeded. */
export interface CallResult<T> {
  data: T;
  replayed: boolean;
  idempotencyKey?: string;
}

/**
 * The single door to PayPal. Every outbound call passes, in order:
 *   1. the profile whitelist (2.3)
 *   2. argument validation against the toolkit's own schema
 *   3. the idempotency ledger for state-changing calls (2.5)
 *   4. token refresh with one retry on 401 (2.1)
 *   5. backoff and retry on 429, 5xx and network failures, with full error logging (2.11)
 */
export class PayPalGateway {
  private readonly retry: RetryOptions;
  private readonly runTool: ToolRunner;
  private readonly fetchFn: FetchLike;

  constructor(private readonly options: GatewayOptions) {
    this.runTool = options.runTool ?? runToolkitMethod;
    this.fetchFn = options.fetchFn ?? fetch;
    this.retry = {
      ...DEFAULT_RETRY,
      ...options.retry,
      onRetry: (info) => {
        this.logError("retrying PayPal call", info.error, { attempt: info.attempt, delayMs: info.delayMs });
        options.retry?.onRetry?.(info);
      },
    };
  }

  get sandbox(): boolean {
    return this.options.tokens.environment === "SANDBOX";
  }

  /** Calls a whitelisted toolkit tool. Pass an idempotency key for anything that is not a read. */
  async callTool<T = unknown>(
    profile: Profile,
    tool: string,
    args: unknown,
    opts: CallOptions = {},
  ): Promise<CallResult<T>> {
    assertAllowed(profile, tool);
    if (profile === "seeder" && !this.sandbox)
      throw new Error("The seeder profile is refused outside the sandbox");
    if (isRestOperation(tool)) throw new Error(`"${tool}" is a REST operation; use its wrapper`);

    const definition = toolRegistry().get(tool);
    if (!definition) throw new UnknownToolError(tool);
    const parsed = definition.parameters.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error?.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) ?? [];
      throw new InvalidToolArgumentsError(tool, issues);
    }

    return this.idempotent(profile, tool, parsed.data, opts.idempotencyKey, (requestId) =>
      this.options.tokens.withToken((accessToken) =>
        this.runTool(tool, parsed.data, { accessToken, sandbox: this.sandbox, requestId }),
      ),
    ) as Promise<CallResult<T>>;
  }

  /** Direct REST call for an operation the toolkit lacks. `operation` must be whitelisted for the profile. */
  async callRest<T = unknown>(
    profile: Profile,
    operation: string,
    request: { method: "GET" | "POST" | "PATCH"; path: string; body?: unknown },
    opts: CallOptions = {},
  ): Promise<CallResult<T>> {
    assertAllowed(profile, operation);
    if (profile === "seeder" && !this.sandbox)
      throw new Error("The seeder profile is refused outside the sandbox");
    return this.idempotent(profile, operation, request, opts.idempotencyKey, (requestId) =>
      this.options.tokens.withToken(async (accessToken) => {
        const res = await this.fetchFn(`${this.options.tokens.baseUrl}${request.path}`, {
          method: request.method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
          },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
        });
        if (!res.ok) throw await errorFromResponse(res, operation);
        const text = await res.text();
        return text ? (JSON.parse(text) as unknown) : null;
      }),
    ) as Promise<CallResult<T>>;
  }

  private async idempotent(
    profile: Profile,
    tool: string,
    request: unknown,
    key: string | undefined,
    send: (requestId: string | undefined) => Promise<unknown>,
  ): Promise<CallResult<unknown>> {
    const attempt = () => withRetry(() => send(key), this.retry);

    if (!key) {
      try {
        return { data: await attempt(), replayed: false };
      } catch (error) {
        this.logError("PayPal call failed", error, { tool, profile });
        throw error;
      }
    }

    const claim = await this.options.idempotency.claim({ key, tool, profile, request });
    if (claim.kind === "done") {
      this.options.logger?.info(
        { tool, profile, idempotencyKey: key },
        "PayPal call skipped: already done for this key",
      );
      return { data: claim.response, replayed: true, idempotencyKey: key };
    }
    try {
      const data = await attempt();
      await this.options.idempotency.complete(key, data);
      this.options.logger?.info(
        { tool, profile, idempotencyKey: key, attempt: claim.attempt },
        "PayPal call succeeded",
      );
      return { data, replayed: false, idempotencyKey: key };
    } catch (error) {
      await this.options.idempotency.fail(key, error);
      this.logError("PayPal call failed", error, { tool, profile, idempotencyKey: key });
      throw error;
    }
  }

  /** Logs PayPal's full error body and debug id: these are what PayPal support asks for. */
  private logError(msg: string, error: unknown, extra: Record<string, unknown>): void {
    if (error instanceof PayPalHttpError) {
      this.options.logger?.warn(
        {
          ...extra,
          status: error.status,
          debugId: error.debugId,
          paypalError: error.errorName,
          body: error.body,
        },
        msg,
      );
    } else {
      this.options.logger?.warn({ ...extra, err: error }, msg);
    }
  }
}
