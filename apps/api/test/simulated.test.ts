import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { signSimulatedEvent, SIM_SIGNATURE_HEADER } from "@boomerang/core";
import { events, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import type { WebhookVerifier } from "@boomerang/paypal";
import { buildApp } from "../src/app";

const SECRET = "test-sim-secret";
const rejectAll: WebhookVerifier = { verify: async () => ({ verified: false, reason: "not used" }) };

function failureEvent(id = `WH-SIM-${randomUUID()}`) {
  return JSON.stringify({
    id,
    event_type: "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
    resource_type: "subscription",
    boomerang_simulated: true,
    resource: { id: "I-SIMTEST", billing_info: { outstanding_balance: { currency_code: "USD", value: "29.00" } } },
  });
}

describe.skipIf(!hasTestDb)("simulated webhook route (3.4)", () => {
  let h: DbHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    h = await setupTestDb();
    app = await buildApp({ db: h, verifier: rejectAll, simulation: { secret: SECRET } });
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  const post = (body: string, signature?: string) =>
    app.inject({
      method: "POST",
      url: "/webhooks/simulated",
      headers: { "content-type": "application/json", ...(signature ? { [SIM_SIGNATURE_HEADER]: signature } : {}) },
      payload: body,
    });

  it("accepts a correctly signed event and stores it marked as simulated", async () => {
    const id = `WH-SIM-${randomUUID()}`;
    const body = failureEvent(id);
    const res = await post(body, signSimulatedEvent(SECRET, body));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: false, simulated: true });
    const [row] = await h.db.select().from(events).where(eq(events.paypalEventId, id));
    expect(row).toMatchObject({ simulated: true, source: "simulated", resourceId: "I-SIMTEST", rawBody: body });
  });

  it("rejects a wrong secret, a tampered body, a stale timestamp and a missing signature", async () => {
    const body = failureEvent();
    expect((await post(body, signSimulatedEvent("wrong-secret", body))).statusCode).toBe(400);
    expect((await post(body.replace("29.00", "2900.00"), signSimulatedEvent(SECRET, body))).statusCode).toBe(400);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect((await post(body, signSimulatedEvent(SECRET, body, stale))).statusCode).toBe(400);
    expect((await post(body)).statusCode).toBe(400);
  });

  it("refuses ids that could collide with real PayPal events", async () => {
    const body = failureEvent(`WH-${randomUUID()}`);
    expect((await post(body, signSimulatedEvent(SECRET, body))).statusCode).toBe(400);
  });

  it("does not let a simulated signature pass on the real PayPal route", async () => {
    const body = failureEvent();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/paypal",
      headers: { "content-type": "application/json", [SIM_SIGNATURE_HEADER]: signSimulatedEvent(SECRET, body) },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not exist unless simulation is configured (production, or no secret)", async () => {
    const plain = await buildApp({ db: h, verifier: rejectAll });
    const body = failureEvent();
    const res = await plain.inject({
      method: "POST",
      url: "/webhooks/simulated",
      headers: { "content-type": "application/json", [SIM_SIGNATURE_HEADER]: signSimulatedEvent(SECRET, body) },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    await plain.close();
  });
});
