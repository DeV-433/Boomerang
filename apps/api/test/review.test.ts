import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { processPendingEvents } from "@boomerang/cases";
import { payLinkExpiry, signPayLink } from "@boomerang/core";
import { cases, customers, events, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import { buildApp } from "../src/app";

const TOKEN = "review-test-token";
const SECRET = "review-test-secret-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date("2026-11-10T15:00:00Z");

/** B6: the opt-out every message promises, and replies the operator received outside Boomerang. */
describe.skipIf(!hasTestDb)("customer replies and opt-out (B6)", () => {
  let h: DbHandle;
  let app: FastifyInstance;

  async function openCase() {
    const [cust] = await h.db
      .insert(customers)
      .values({ email: `review-${randomUUID()}@example.com`, simulated: true })
      .returning();
    const [c] = await h.db
      .insert(cases)
      .values({
        lane: "invoice",
        paypalRef: `INV2-REVIEW-${randomUUID()}`,
        customerId: cust!.id,
        amountCents: 9_900,
        currency: "USD",
        state: "awaiting",
        openedAt: NOW,
      })
      .returning();
    return { c: c!, token: signPayLink(SECRET, c!.id, payLinkExpiry(NOW)) };
  }
  const optedOut = async (customerId: string) =>
    (await h.db.select().from(customers).where(eq(customers.id, customerId)))[0]!.optedOut;

  beforeAll(async () => {
    h = await setupTestDb();
    app = await buildApp({
      db: h,
      verifier: { verify: async () => ({ verified: true }) },
      operatorToken: TOKEN,
      payLinkSecret: SECRET,
      now: () => NOW,
    });
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("the pay page has a stop button that opts the customer out, once", async () => {
    const { c, token } = await openCase();
    expect((await app.inject({ url: `/pay/${token}` })).body).toContain(`/pay/${token}/stop`);
    const stop = (payload = "") =>
      app.inject({
        method: "POST",
        url: `/pay/${token}/stop`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload,
      });
    expect((await stop("amount=1")).statusCode).toBe(400);
    const res = await stop();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("We will not send you any more reminders");
    expect((await stop()).statusCode).toBe(200); // a second press adds nothing
    const stored = await h.db.select().from(events).where(eq(events.resourceId, c.paypalRef));
    expect(stored).toHaveLength(1); // two presses, one event
    await processPendingEvents(h.db, { now: () => NOW });
    expect(await optedOut(c.customerId)).toBe(true);
  });

  it("the operator can record a labelled reply, or leave it to the classifier", async () => {
    const { c } = await openCase();
    const post = (payload: object) =>
      app.inject({ method: "POST", url: `/api/cases/${c.id}/reply`, headers: auth, payload });
    expect((await post({ text: "x", promiseDate: "2026-11-12" })).statusCode).toBe(400);

    const unlabelled = await post({ text: "Who are you? I never ordered this." });
    expect(unlabelled.json()).toMatchObject({ classifiedBy: "model", label: null });
    // Unlabelled text waits for the classifier; the case opener does not see it yet.
    const [waiting] = await h.db
      .select()
      .from(events)
      .where(eq(events.paypalEventId, unlabelled.json<{ eventId: string }>().eventId));
    expect(waiting!.processedAt).toBeNull();

    const labelled = await post({ text: "Please stop emailing me.", label: "opt_out" });
    expect(labelled.statusCode, labelled.body).toBe(200);
    await processPendingEvents(h.db, { now: () => NOW });
    expect(await optedOut(c.customerId)).toBe(true);
    await h.db
      .update(events)
      .set({ processedAt: NOW })
      .where(eq(events.paypalEventId, unlabelled.json<{ eventId: string }>().eventId));
  });

  it("refuses a reply on a closed case", async () => {
    const { c } = await openCase();
    await h.db.update(cases).set({ state: "recovered", closedAt: NOW }).where(eq(cases.id, c.id));
    const res = await app.inject({
      method: "POST",
      url: `/api/cases/${c.id}/reply`,
      headers: auth,
      payload: { text: "paid", label: "other" },
    });
    expect(res.statusCode).toBe(409);
  });
});
