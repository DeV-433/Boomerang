import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { events, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import type { WebhookVerifier } from "@boomerang/paypal";
import { buildApp } from "../src/app";
import { checkTransmissionTime, REPLAY_WINDOW_MS } from "../src/routes/webhooks";

const TAMPER_MARKER = "TAMPERED";

/** Stands in for PayPal's verification API: anything containing the marker fails, everything else passes. */
const fakeVerifier: WebhookVerifier = {
  async verify(headers, rawBody) {
    if (!headers["paypal-transmission-sig"]) return { verified: false, reason: "missing headers" };
    return rawBody.includes(TAMPER_MARKER) ? { verified: false, reason: "FAILURE" } : { verified: true };
  },
};

const signed = {
  "content-type": "application/json",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT",
  "paypal-transmission-id": "tx",
  "paypal-transmission-sig": "sig",
  // Fresh on every delivery, as PayPal's are (9.6 rejects stale transmissions).
  get "paypal-transmission-time"() {
    return new Date().toISOString();
  },
};

function sampleEvent(id = `WH-${randomUUID()}`): string {
  // Spacing and key order kept as sent, to prove the raw bytes are stored untouched.
  // Shape matches a real sandbox INVOICING.* event: the invoice is nested under resource.invoice.
  return `{"id":"${id}","event_type":"INVOICING.INVOICE.PAID","resource_type":"invoices",  "resource":{"invoice":{"id":"INV2-AAAA"}}}`;
}

describe.skipIf(!hasTestDb)("api", () => {
  let h: DbHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    h = await setupTestDb();
    app = await buildApp({ db: h, verifier: fakeVerifier });
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  // 1.7
  it("GET /healthz returns 200 after pinging the database", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "ok" });
  });

  // 1.8
  it("stores the raw body and PayPal headers of a webhook", async () => {
    const id = `WH-${randomUUID()}`;
    const body = sampleEvent(id);
    const res = await app.inject({ method: "POST", url: "/webhooks/paypal", headers: signed, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: false });

    const [row] = await h.db.select().from(events).where(eq(events.paypalEventId, id));
    expect(row).toMatchObject({
      type: "INVOICING.INVOICE.PAID",
      resourceType: "invoices",
      resourceId: "INV2-AAAA",
    });
    expect(row!.rawBody).toBe(body);
    expect(row!.headers).toMatchObject({
      "paypal-transmission-id": "tx",
      "content-type": "application/json",
    });
    expect(row!.processedAt).toBeNull();
  });

  // 1.9
  it("rejects a tampered event with 400 and stores nothing", async () => {
    const id = `WH-${randomUUID()}`;
    const body = sampleEvent(id).replace("INV2-AAAA", TAMPER_MARKER);
    const res = await app.inject({ method: "POST", url: "/webhooks/paypal", headers: signed, payload: body });
    expect(res.statusCode).toBe(400);
    expect(await h.db.select().from(events).where(eq(events.paypalEventId, id))).toHaveLength(0);
  });

  it("rejects an unsigned event and malformed JSON with 400", async () => {
    const unsigned = await app.inject({
      method: "POST",
      url: "/webhooks/paypal",
      headers: { "content-type": "application/json" },
      payload: sampleEvent(),
    });
    expect(unsigned.statusCode).toBe(400);
    const malformed = await app.inject({
      method: "POST",
      url: "/webhooks/paypal",
      headers: signed,
      payload: "{nope",
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("returns 503 when PayPal verification is unreachable, so PayPal retries", async () => {
    const failing = await buildApp({
      db: h,
      verifier: {
        verify: async () => {
          throw new Error("network down");
        },
      },
    });
    const res = await failing.inject({
      method: "POST",
      url: "/webhooks/paypal",
      headers: signed,
      payload: sampleEvent(),
    });
    expect(res.statusCode).toBe(503);
    await failing.close();
  });

  it("reads the resource id from subscription-style events too", async () => {
    const id = `WH-${randomUUID()}`;
    const body = `{"id":"${id}","event_type":"BILLING.SUBSCRIPTION.PAYMENT.FAILED","resource_type":"subscription","resource":{"id":"I-SUB123"}}`;
    const res = await app.inject({ method: "POST", url: "/webhooks/paypal", headers: signed, payload: body });
    expect(res.statusCode).toBe(200);
    const [row] = await h.db.select().from(events).where(eq(events.paypalEventId, id));
    expect(row!.resourceId).toBe("I-SUB123");
  });

  // 1.10
  it("stores an event delivered twice exactly once", async () => {
    const id = `WH-${randomUUID()}`;
    const send = () =>
      app.inject({ method: "POST", url: "/webhooks/paypal", headers: signed, payload: sampleEvent(id) });
    const [first, second] = await Promise.all([send(), send()]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect([first.json().duplicate, second.json().duplicate].sort()).toEqual([false, true]);
    expect(await h.db.select().from(events).where(eq(events.paypalEventId, id))).toHaveLength(1);
  });
});

describe.skipIf(!hasTestDb)("webhook hardening (9.6)", () => {
  let h: DbHandle;
  let app: FastifyInstance;
  let calls = 0;
  const counting: WebhookVerifier = {
    async verify(headers, rawBody) {
      calls++;
      return fakeVerifier.verify(headers, rawBody);
    },
  };
  beforeAll(async () => {
    h = await setupTestDb();
    app = await buildApp({ db: h, verifier: counting, webhookRateLimitPerMinute: 5 });
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });
  const deliver = (headers: Record<string, string>, payload = sampleEvent(), ip = "203.0.113.7") =>
    app.inject({ method: "POST", url: "/webhooks/paypal", headers, payload, remoteAddress: ip });

  it("signature: an unsigned or tampered delivery is rejected and nothing is stored", async () => {
    const id = `WH-${randomUUID()}`;
    const { "paypal-transmission-sig": _sig, ...unsigned } = { ...signed };
    expect(
      (
        await deliver(
          { ...unsigned, "paypal-transmission-time": new Date().toISOString() },
          sampleEvent(id),
          "198.51.100.1",
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await deliver({ ...signed }, sampleEvent(id).replace("INV2-AAAA", TAMPER_MARKER), "198.51.100.1"))
        .statusCode,
    ).toBe(400);
    expect(await h.db.select().from(events).where(eq(events.paypalEventId, id))).toHaveLength(0);
  });

  it("replay window: a stale or future transmission is rejected before PayPal is asked", async () => {
    const before = calls;
    const id = `WH-${randomUUID()}`;
    const old = new Date(Date.now() - REPLAY_WINDOW_MS - 60_000).toISOString();
    const ahead = new Date(Date.now() + 10 * 60_000).toISOString();
    const r1 = await deliver({ ...signed, "paypal-transmission-time": old }, sampleEvent(id), "198.51.100.2");
    const r2 = await deliver(
      { ...signed, "paypal-transmission-time": ahead },
      sampleEvent(id),
      "198.51.100.2",
    );
    const r3 = await deliver(
      { ...signed, "paypal-transmission-time": "not a date" },
      sampleEvent(id),
      "198.51.100.2",
    );
    expect([r1.statusCode, r2.statusCode, r3.statusCode]).toEqual([400, 400, 400]);
    expect(r1.json()).toEqual({ error: "stale_or_missing_transmission_time" });
    expect(calls).toBe(before); // never reached the verification call
    expect(await h.db.select().from(events).where(eq(events.paypalEventId, id))).toHaveLength(0);
    // A fresh delivery of the same event is accepted.
    expect((await deliver({ ...signed }, sampleEvent(id), "198.51.100.2")).statusCode).toBe(200);
  });

  it("checks the window at its edges", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
    expect(checkTransmissionTime(at(-REPLAY_WINDOW_MS + 1000), now).ok).toBe(true);
    expect(checkTransmissionTime(at(-REPLAY_WINDOW_MS - 1000), now).ok).toBe(false);
    expect(checkTransmissionTime(at(4 * 60_000), now).ok).toBe(true);
    expect(checkTransmissionTime(at(6 * 60_000), now).ok).toBe(false);
    expect(checkTransmissionTime(undefined, now).ok).toBe(false);
  });

  it("rate limit: one address gets 429 after its allowance, another is unaffected", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++)
      codes.push((await deliver({ ...signed }, sampleEvent(), "192.0.2.50")).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429]);
    expect((await deliver({ ...signed }, sampleEvent(), "192.0.2.51")).statusCode).toBe(200);
  });

  it("rejects an oversized body", async () => {
    const big = `{"id":"WH-${randomUUID()}","event_type":"X","pad":"${"x".repeat(300 * 1024)}"}`;
    expect((await deliver({ ...signed }, big, "198.51.100.3")).statusCode).toBe(413);
  });
});
