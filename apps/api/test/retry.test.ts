import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { processPendingEvents, reportWorkerMode, runCaseCheck } from "@boomerang/cases";
import { payLinkExpiry, signPayLink } from "@boomerang/core";
import { actions, approvals, auditLog, cases, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import { buildApp } from "../src/app";
import {
  caseByRef,
  fakePayPal,
  hoursLater,
  setCustomerTimezone,
  storeEvent,
  TUESDAY_10AM_NY,
} from "../../../packages/cases/test/helpers";

const TOKEN = "retry-test-token";
const SECRET = "retry-test-secret-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const NOW = TUESDAY_10AM_NY;

/**
 * 8.5 and 8.6 end to end: a subscriber whose card was declined fixes it and presses "try the
 * payment again" on the pay page. The next check proposes capturing the balance, the gate holds
 * that for a person (rule 12), approving it calls PayPal's capture, and PayPal's completed sale
 * closes the case as recovered.
 */
describe.skipIf(!hasTestDb)("manual retry after a payment update, as a gated capture (8.5, 8.6)", () => {
  let h: DbHandle;
  let app: FastifyInstance;
  const fake = fakePayPal();
  const ref = `I-RETRY${Date.now()}`;

  beforeAll(async () => {
    h = await setupTestDb();
    // B15: the API sends live only when the worker reports live as well.
    await reportWorkerMode(h.db, "live");
    app = await buildApp({
      db: h,
      verifier: { verify: async () => ({ verified: true }) },
      operatorToken: TOKEN,
      gateway: fake.gateway,
      policyMode: "live",
      payLinkSecret: SECRET,
      now: () => NOW,
    });
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("moves the case from a declined payment to a held capture, then to recovered once approved", async () => {
    // A hard decline: Boomerang asks for a card update, and nothing PayPal does will fix it alone.
    await storeEvent(h.db, "BILLING.SUBSCRIPTION.PAYMENT.FAILED", {
      id: ref,
      status: "ACTIVE",
      subscriber: { payer_id: `P${ref}`, email_address: `${ref}@example.com` },
      billing_info: {
        failed_payments_count: 1,
        outstanding_balance: { currency_code: "USD", value: "29.00" },
        last_failed_payment: { reason_code: "PAYER_CANNOT_PAY" },
      },
    });
    await processPendingEvents(h.db, { now: () => NOW });
    const c = await caseByRef(h.db, ref);
    await setCustomerTimezone(h.db, c.customerId, "America/New_York");
    const live = { db: h.db, gateway: fake.gateway, mode: "live" as const, now: () => NOW };
    await runCaseCheck(live, c.id);
    expect(await caseByRef(h.db, ref)).toMatchObject({ cause: "expired_funding_source", state: "awaiting" });

    // The subscriber's pay page offers the retry button; pressing it records the update once.
    const token = signPayLink(SECRET, c.id, payLinkExpiry(c.openedAt));
    const pageBefore = await app.inject({ url: `/pay/${token}` });
    expect(pageBefore.body).toContain(`/pay/${token}/updated`);
    const press = () =>
      app.inject({
        method: "POST",
        url: `/pay/${token}/updated`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "",
      });
    expect((await press()).statusCode).toBe(200);
    expect((await press()).statusCode).toBe(200); // a second press adds nothing
    const smuggled = await app.inject({
      method: "POST",
      url: `/pay/${token}/updated`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "amount=1",
    });
    expect(smuggled.statusCode).toBe(400);
    expect(await processPendingEvents(h.db, { now: () => NOW })).toBe(1); // two presses, one event
    expect((await caseByRef(h.db, ref)).paymentUpdatedAt).not.toBeNull();
    expect((await app.inject({ url: `/pay/${token}` })).body).toContain(
      "We will try the payment again shortly",
    );

    // The check proposes the retry as a balance capture; it moves money, so a person must approve it.
    const held = await runCaseCheck(live, c.id);
    expect(held.outcome).toBe("held");
    expect(held.decision).toMatchObject({ verdict: "hold", decidedBy: 12 });
    expect(await caseByRef(h.db, ref)).toMatchObject({ cause: "payment_method_updated", state: "approval" });
    const captures = () =>
      fake.calls.filter((x) => x.tool.endsWith(`/v1/billing/subscriptions/${ref}/capture`));
    expect(captures()).toHaveLength(0);

    const [action] = await h.db
      .select()
      .from(actions)
      .where(and(eq(actions.caseId, c.id), eq(actions.action, "request_balance_capture")));
    const [approval] = await h.db.select().from(approvals).where(eq(approvals.actionId, action!.id));
    const res = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval!.id}/decision`,
      headers: auth,
      payload: { decision: "approve" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(captures()).toHaveLength(1);
    expect(captures()[0]!.args).toMatchObject({
      capture_type: "OUTSTANDING_BALANCE",
      amount: { currency_code: "USD", value: "29.00" },
    });
    // The update bought exactly one retry.
    expect((await caseByRef(h.db, ref)).paymentUpdatedAt).toBeNull();

    // PayPal reports the captured payment: the case is recovered.
    await storeEvent(h.db, "PAYMENT.SALE.COMPLETED", {
      id: `SALE-${ref}`,
      billing_agreement_id: ref,
      amount: { total: "29.00" },
    });
    await processPendingEvents(h.db, { now: () => hoursLater(NOW, 1) });
    expect(await caseByRef(h.db, ref)).toMatchObject({ state: "recovered", recoveredCents: 2900 });
    const actors = await h.db
      .select({ actor: auditLog.actor })
      .from(auditLog)
      .where(and(eq(auditLog.caseId, c.id), eq(auditLog.kind, "event_received")));
    expect(actors.map((a) => a.actor)).toContain("customer:paypage");
    expect((await h.db.select().from(cases).where(eq(cases.id, c.id)))[0]!.closeReason).toMatch(/completed/);
  });

  it("an invoice page has no retry button and refuses the request", async () => {
    const [sub] = await h.db.select().from(cases).where(eq(cases.paypalRef, ref));
    const [inv] = await h.db
      .insert(cases)
      .values({
        lane: "invoice",
        paypalRef: `INV2-RTRY-${Date.now()}`,
        customerId: sub!.customerId,
        amountCents: 5_000,
        currency: "USD",
        state: "awaiting",
        simulated: true,
      })
      .returning();
    const token = signPayLink(SECRET, inv!.id, payLinkExpiry(inv!.openedAt));
    expect((await app.inject({ url: `/pay/${token}` })).body).not.toContain("/updated");
    const res = await app.inject({
      method: "POST",
      url: `/pay/${token}/updated`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    expect(res.statusCode).toBe(400);
  });
});
