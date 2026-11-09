import { describe, expect, it, vi } from "vitest";
import { TokenManager } from "../src/auth";
import { buildVerificationBody, PayPalWebhookVerifier } from "../src/webhooks";
import type { FetchLike } from "../src/http";

const headers = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": "sig==",
  "paypal-transmission-time": "2026-11-09T10:00:00Z",
};
// Deliberately unusual formatting: verification must forward these bytes untouched.
const rawBody = '{"id":"WH-1","event_type":"INVOICING.INVOICE.PAID", "resource":{"amount":10.50}}';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fake PayPal: issues a token, and reports SUCCESS only for the untampered body. */
function fakePayPal(): { fetchFn: FetchLike; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const body = String(init?.body ?? "");
    calls.push({ url, body });
    if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "tok", expires_in: 32400 });
    if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
      return json({ verification_status: body.includes(rawBody) ? "SUCCESS" : "FAILURE" });
    }
    return json({}, 404);
  };
  return { fetchFn, calls };
}

function verifierWith(fetchFn: FetchLike, webhookId: string | null = "WH-ID") {
  const tokens = new TokenManager(
    { clientId: "id", clientSecret: "secret", environment: "SANDBOX" },
    fetchFn,
  );
  return new PayPalWebhookVerifier(tokens, webhookId ?? undefined, fetchFn);
}

describe("buildVerificationBody", () => {
  it("embeds the raw event bytes verbatim and produces valid JSON", () => {
    const body = buildVerificationBody(headers, rawBody, "WH-ID")!;
    expect(body).toContain(`"webhook_event":${rawBody}`);
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({
      auth_algo: "SHA256withRSA",
      transmission_id: "tx-1",
      webhook_id: "WH-ID",
    });
    expect(parsed.webhook_event.id).toBe("WH-1");
  });

  it("returns null when a transmission header is missing", () => {
    const { "paypal-transmission-sig": _omit, ...partial } = headers;
    expect(buildVerificationBody(partial, rawBody, "WH-ID")).toBeNull();
  });
});

describe("PayPalWebhookVerifier", () => {
  it("passes a valid event", async () => {
    const { fetchFn, calls } = fakePayPal();
    await expect(verifierWith(fetchFn).verify(headers, rawBody)).resolves.toEqual({ verified: true });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature",
    ]);
  });

  it("rejects a tampered event", async () => {
    const { fetchFn } = fakePayPal();
    const tampered = rawBody.replace("10.50", "1050.00");
    await expect(verifierWith(fetchFn).verify(headers, tampered)).resolves.toMatchObject({ verified: false });
  });

  it("rejects without calling PayPal when headers or webhook id are missing", async () => {
    const fetchFn = vi.fn<FetchLike>();
    await expect(verifierWith(fetchFn).verify({}, rawBody)).resolves.toMatchObject({ verified: false });
    await expect(verifierWith(fetchFn, null).verify(headers, rawBody)).resolves.toMatchObject({
      reason: "PAYPAL_WEBHOOK_ID is not configured",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reuses a cached token", async () => {
    const { fetchFn, calls } = fakePayPal();
    const verifier = verifierWith(fetchFn);
    await verifier.verify(headers, rawBody);
    await verifier.verify(headers, rawBody);
    expect(calls.filter((c) => c.url.endsWith("/oauth2/token"))).toHaveLength(1);
  });
});
