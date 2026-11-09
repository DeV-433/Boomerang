import { PayPalHttpError } from "./http";

export interface RetryOptions {
  /** Total attempts including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/**
 * Rate limits, server errors and network failures are worth retrying. Client errors are not:
 * repeating a 400 or 422 gives the same answer. 401 is handled separately by a token refresh.
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof PayPalHttpError)) return false;
  if (error.status === null) return true;
  return error.status === 429 || error.status >= 500;
}

/** Exponential backoff with full jitter, honouring Retry-After when PayPal sends one. */
export function backoffDelay(attempt: number, error: unknown, options: RetryOptions): number {
  if (error instanceof PayPalHttpError && error.retryAfterMs !== null) {
    return Math.min(error.retryAfterMs, options.maxDelayMs);
  }
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(options.random() * ceiling);
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = DEFAULT_RETRY): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= options.maxAttempts || !isRetryable(error)) throw error;
      const delayMs = backoffDelay(attempt, error, options);
      options.onRetry?.({ attempt, delayMs, error });
      await options.sleep(delayMs);
    }
  }
}
