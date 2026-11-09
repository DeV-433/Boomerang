export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PayPalEnvironment = "SANDBOX" | "PRODUCTION";

export function apiBaseUrl(environment: PayPalEnvironment): string {
  return environment === "PRODUCTION" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

/**
 * Any failed PayPal call, from the toolkit or from a direct REST request. Keeps the full response
 * body and PayPal's debug id so failures can be traced with PayPal support.
 */
export class PayPalHttpError extends Error {
  constructor(
    readonly status: number | null,
    readonly body: string,
    readonly debugId: string | null,
    context: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(
      `${context} failed with ${status === null ? "no response" : `HTTP ${status}`}${debugId ? ` (debug id ${debugId})` : ""}`,
    );
    this.name = "PayPalHttpError";
  }

  /** PayPal's error name, for example "RATE_LIMIT_REACHED" or "INVALID_RESOURCE_ID", when the body has one. */
  get errorName(): string | null {
    try {
      const parsed = JSON.parse(this.body) as { name?: unknown; error?: unknown };
      const name = parsed.name ?? parsed.error;
      return typeof name === "string" ? name : null;
    } catch {
      return null;
    }
  }
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export async function errorFromResponse(res: Response, context: string): Promise<PayPalHttpError> {
  return new PayPalHttpError(
    res.status,
    await res.text(),
    res.headers.get("paypal-debug-id"),
    context,
    parseRetryAfter(res.headers.get("retry-after")),
  );
}
