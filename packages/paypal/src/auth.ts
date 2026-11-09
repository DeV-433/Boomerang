import {
  apiBaseUrl,
  errorFromResponse,
  PayPalHttpError,
  type FetchLike,
  type PayPalEnvironment,
} from "./http";

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
  environment: PayPalEnvironment;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/** Refresh this long before PayPal's stated expiry, so a token never expires mid-request. */
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/**
 * Step 2.1: fetches, caches and refreshes OAuth access tokens. Concurrent callers share one
 * in-flight request. The clock is injectable so refresh timing can be tested.
 *
 * The toolkit's own client caches its token for the life of the process and never refreshes it,
 * so every toolkit call is given a token from here instead.
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

  get environment(): PayPalEnvironment {
    return this.credentials.environment;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - EXPIRY_MARGIN_MS) return this.cached.value;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Drops the cached token, so the next call fetches a new one. */
  invalidate(rejected?: string): void {
    if (rejected === undefined || this.cached?.value === rejected) this.cached = null;
  }

  /**
   * Runs `fn` with a token. If PayPal answers 401 (token revoked or expired early), fetches a fresh
   * token and retries exactly once.
   */
  async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.getToken();
    try {
      return await fn(token);
    } catch (error) {
      if (!(error instanceof PayPalHttpError) || error.status !== 401) throw error;
      this.invalidate(token);
      return fn(await this.getToken());
    }
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString(
      "base64",
    );
    const res = await this.fetchFn(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw await errorFromResponse(res, "token request");
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { value: json.access_token, expiresAt: this.now() + json.expires_in * 1000 };
    return json.access_token;
  }
}
