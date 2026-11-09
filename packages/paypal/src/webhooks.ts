import { errorFromResponse, type FetchLike } from "./http";
import type { TokenManager } from "./auth";

/** The transmission headers PayPal attaches to every webhook delivery (lower-cased). */
export const PAYPAL_WEBHOOK_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
] as const;

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export type VerifyResult = { verified: true } | { verified: false; reason: string };

export interface WebhookVerifier {
  verify(headers: WebhookHeaders, rawBody: string): Promise<VerifyResult>;
}

function header(headers: WebhookHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Builds the verify-webhook-signature request body. The webhook event is inserted as the exact raw
 * bytes PayPal sent, not a re-serialized object: re-serializing can reorder keys or change number
 * formatting, which breaks the signature.
 */
export function buildVerificationBody(
  headers: WebhookHeaders,
  rawBody: string,
  webhookId: string,
): string | null {
  const fields: Record<string, string> = {};
  for (const name of PAYPAL_WEBHOOK_HEADERS) {
    const value = header(headers, name);
    if (!value) return null;
    fields[name.replace(/^paypal-/, "").replace(/-/g, "_")] = value;
  }
  const parts = [
    `"auth_algo":${JSON.stringify(fields.auth_algo)}`,
    `"cert_url":${JSON.stringify(fields.cert_url)}`,
    `"transmission_id":${JSON.stringify(fields.transmission_id)}`,
    `"transmission_sig":${JSON.stringify(fields.transmission_sig)}`,
    `"transmission_time":${JSON.stringify(fields.transmission_time)}`,
    `"webhook_id":${JSON.stringify(webhookId)}`,
    `"webhook_event":${rawBody}`,
  ];
  return `{${parts.join(",")}}`;
}

/** Verifies webhook signatures with PayPal's /v1/notifications/verify-webhook-signature API. */
export class PayPalWebhookVerifier implements WebhookVerifier {
  constructor(
    private readonly tokens: TokenManager,
    private readonly webhookId: string | undefined,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  async verify(headers: WebhookHeaders, rawBody: string): Promise<VerifyResult> {
    if (!this.webhookId) return { verified: false, reason: "PAYPAL_WEBHOOK_ID is not configured" };
    const body = buildVerificationBody(headers, rawBody, this.webhookId);
    if (!body) return { verified: false, reason: "missing PayPal transmission headers" };

    const json = await this.tokens.withToken(async (token) => {
      const res = await this.fetchFn(`${this.tokens.baseUrl}/v1/notifications/verify-webhook-signature`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) throw await errorFromResponse(res, "webhook verification");
      return (await res.json()) as { verification_status?: string };
    });
    return json.verification_status === "SUCCESS"
      ? { verified: true }
      : { verified: false, reason: `verification_status=${json.verification_status ?? "missing"}` };
  }
}
