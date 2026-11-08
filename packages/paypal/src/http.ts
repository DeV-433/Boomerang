export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PayPalEnvironment = "SANDBOX" | "PRODUCTION";

export function apiBaseUrl(environment: PayPalEnvironment): string {
  return environment === "PRODUCTION" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

export class PayPalHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly debugId: string | null,
    context: string,
  ) {
    super(`${context} failed with HTTP ${status}${debugId ? ` (debug id ${debugId})` : ""}`);
    this.name = "PayPalHttpError";
  }
}
