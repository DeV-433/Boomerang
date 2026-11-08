import { apiBaseUrl, PayPalHttpError, type FetchLike, type PayPalEnvironment } from "./http";

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
  environment: PayPalEnvironment;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/** Refresh this long before PayPal's stated expiry. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/**
 * Fetches and caches an OAuth access token using client credentials.
 * Minimal version for Phase 1; step 2.1 adds a fake-clock test and retry-on-401.
 */
export class TokenManager {
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly credentials: PayPalCredentials,
    private readonly fetchFn: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get baseUrl(): string {
    return apiBaseUrl(this.credentials.environment);
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - EXPIRY_MARGIN_MS) return this.cached.value;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = null;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString("base64");
    const res = await this.fetchFn(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      throw new PayPalHttpError(res.status, await res.text(), res.headers.get("paypal-debug-id"), "token request");
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { value: json.access_token, expiresAt: this.now() + json.expires_in * 1000 };
    return json.access_token;
  }
}
