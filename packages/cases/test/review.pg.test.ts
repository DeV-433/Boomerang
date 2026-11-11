import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { verifyChain } from "@boomerang/audit";
import { AUDIT_CHAIN_LOCK, actions, approvals, cases, customers, jobs, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import { processPendingEvents } from "../src/events";
import { executeAction } from "../src/executor";
import { runDueJobs } from "../src/jobs";
import { decideApproval, runCaseCheck, type LoopDeps, type Proposer } from "../src/loop";
import { configurePayPalWeb, paypalPayLink } from "../src/messages";
import { proposeByRules } from "../src/propose";
import { loadPolicy, setSystemPaused } from "../src/store";
import {
  caseByRef,
  fakePayPal,
  hoursLater,
  invoiceId,
  overdueInvoice,
  setCustomerTimezone,
  storeEvent,
  tool,
  TUESDAY_10AM_NY,
} from "./helpers";

/** Regression tests for the bugs found in the 2026-11-11 code review (B1 to B14). */
describe.skipIf(!hasTestDb)("review fixes", () => {
  let h: DbHandle;
  let firstAuditId = 0;
  beforeAll(async () => {
    h = await setupTestDb();
    await setSystemPaused(h.db, false, "test");
    const r = await h.pool.query<{ id: string }>("select coalesce(max(id), 0) as id from audit_log");
    firstAuditId = Number(r.rows[0]!.id) + 1;
  });
  afterAll(async () => {
    configurePayPalWeb("SANDBOX");
    await h?.close();
  });

  const live = (fake: ReturnType<typeof fakePayPal>, now: Date, extra: Partial<LoopDeps> = {}): LoopDeps => ({
    db: h.db,
    gateway: fake.gateway,
    mode: "live",
    now: () => now,
    ...extra,
  });
  const due = (deps: LoopDeps, ...ids: string[]) => runDueJobs(deps, { caseIds: ids });
  const actionsOf = (caseId: string) => h.db.select().from(actions).where(eq(actions.caseId, caseId));

  async function openInvoiceCase(cents = 25_000, invoiceNumber?: string) {
    const id = invoiceId();
    const inv = overdueInvoice(id, cents);
    const invoice = invoiceNumber
      ? { ...inv, detail: { ...inv.detail, invoice_number: invoiceNumber } }
      : inv;
    await storeEvent(h.db, "BOOMERANG.INVOICE.OVERDUE", { invoice }, { source: "poll" });
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    const c = await caseByRef(h.db, id);
    await setCustomerTimezone(h.db, c.customerId, "America/New_York");
    return c;
  }

  async function openSubscriptionCase(failed: number, reason = "PAYER_CANNOT_PAY") {
    const ref = `I-REVIEW${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await storeEvent(h.db, "BILLING.SUBSCRIPTION.PAYMENT.FAILED", {
      id: ref,
      status: "ACTIVE",
      subscriber: { payer_id: `P${ref}`, email_address: `${ref.toLowerCase()}@example.com` },
      billing_info: {
        failed_payments_count: failed,
        outstanding_balance: { currency_code: "USD", value: "29.00" },
        last_failed_payment: { reason_code: reason },
      },
    });
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    const c = await caseByRef(h.db, ref);
    await setCustomerTimezone(h.db, c.customerId, "America/New_York");
    return c;
  }

  // B1 -------------------------------------------------------------------------------------------------

  it("B1: a reminder that failed at PayPal is sent and recorded on the retry (no key clash)", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    fake.failNext.set("send_invoice_reminder", 400);
    const [first] = await due(live(fake, TUESDAY_10AM_NY), c.id);
    expect(first).toMatchObject({ outcome: "failed" });
    const [failed] = await actionsOf(c.id);
    expect(failed!.status).toBe("failed");
    expect(failed!.idempotencyKey).toBeNull(); // the key stays free for the retry
    expect(failed!.toolResponse).toMatchObject({ idempotencyKey: `${c.id}:send_reminder:0` });

    const [second] = await due(live(fake, hoursLater(TUESDAY_10AM_NY, 1)), c.id);
    expect(second).toMatchObject({ outcome: "executed" });
    const executed = (await actionsOf(c.id)).filter((a) => a.status === "executed");
    expect(executed).toHaveLength(1);
    expect(executed[0]!.idempotencyKey).toBe(`${c.id}:send_reminder:0`);
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(2); // one failed attempt, one real send
    expect(await caseByRef(h.db, c.paypalRef)).toMatchObject({ state: "awaiting", contacts: 1 });
  });

  it("B1: a second balance capture on one case reaches PayPal with its own key", async () => {
    const fake = fakePayPal();
    const c = await openSubscriptionCase(3);
    const captures = () =>
      fake.calls.filter((x) => x.tool.endsWith(`/v1/billing/subscriptions/${c.paypalRef}/capture`));
    const approveHeld = async (now: Date) => {
      const held = await runCaseCheck(live(fake, now), c.id);
      expect(held).toMatchObject({ outcome: "held" });
      const [a] = (await actionsOf(c.id)).filter((x) => x.status === "held");
      return decideApproval(live(fake, now), a!.id, { approve: true, by: "operator:test" });
    };
    expect(await approveHeld(TUESDAY_10AM_NY)).toMatchObject({ outcome: "executed" });
    // The capture did not clear the balance (no completed sale arrived); the next check asks again.
    expect(await approveHeld(hoursLater(TUESDAY_10AM_NY, 24))).toMatchObject({ outcome: "executed" });
    expect(captures()).toHaveLength(2);
    const keys = (await actionsOf(c.id)).filter((a) => a.status === "executed").map((a) => a.idempotencyKey);
    expect(keys.sort()).toEqual([
      `${c.id}:request_balance_capture:0`,
      `${c.id}:request_balance_capture:0:retry1`,
    ]);
  });

  // B2 -------------------------------------------------------------------------------------------------

  it("B2: an approval given outside contact hours is kept and sent, as edited, when the window opens", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase(450_000);
    expect(await runCaseCheck(live(fake, TUESDAY_10AM_NY), c.id)).toMatchObject({ outcome: "held" });
    const [held] = await actionsOf(c.id);
    const original = held!.message as { subject: string; body: string; tone: string; template: string };
    const edited = {
      ...original,
      body: original.body.replace("Just a friendly reminder:", "A kind reminder:"),
    };
    const night = new Date("2026-11-11T03:00:00Z"); // 22:00 in New York
    const approved = await decideApproval(live(fake, night), held!.id, {
      approve: true,
      by: "operator:test",
      editedMessage: edited as never,
    });
    expect(approved).toMatchObject({ outcome: "deferred" });
    expect((await actionsOf(c.id))[0]!.status).toBe("approved");
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(0);

    const [next] = await due(live(fake, new Date("2026-11-11T14:00:00Z")), c.id); // 09:00 New York
    expect(next).toMatchObject({ outcome: "executed" });
    const all = await actionsOf(c.id);
    expect(all).toHaveLength(1); // no second proposal, no second approval
    expect(all[0]!.status).toBe("executed");
    const sends = tool(fake, "send_invoice_reminder");
    expect(sends).toHaveLength(1);
    expect(String(sends[0]!.args.note)).toContain("A kind reminder:");
    const rows = await h.db.select().from(approvals).where(eq(approvals.actionId, held!.id));
    expect(rows.map((r) => r.status)).toEqual(["edited"]);
  });

  // B3 -------------------------------------------------------------------------------------------------

  it("B3: the proposer runs without the audit-chain lock or a transaction", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    let lockWasFree: boolean | null = null;
    const proposer: Proposer = async (s, d, now) => {
      const r = await h.pool.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [
        AUDIT_CHAIN_LOCK,
      ]);
      lockWasFree = r.rows[0]!.ok;
      if (lockWasFree) await h.pool.query("select pg_advisory_unlock($1)", [AUDIT_CHAIN_LOCK]);
      return proposeByRules(s, d, now);
    };
    const result = await runCaseCheck(live(fake, TUESDAY_10AM_NY, { proposer }), c.id);
    expect(result.outcome).toBe("executed");
    expect(lockWasFree).toBe(true);
  });

  it("B3: a proposal made stale by a change during the model call is discarded and the case checked again", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    const proposer: Proposer = async (s, d, now) => {
      // The customer opts out while the model is thinking.
      await h.db.update(customers).set({ optedOut: true }).where(eq(customers.id, c.customerId));
      return proposeByRules(s, d, now);
    };
    const result = await runCaseCheck(live(fake, TUESDAY_10AM_NY, { proposer }), c.id);
    expect(result).toMatchObject({ outcome: "deferred" });
    expect(await actionsOf(c.id)).toHaveLength(0);
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(0);
    const [again] = await due(live(fake, TUESDAY_10AM_NY), c.id);
    expect(again).toMatchObject({ outcome: "closed", detail: "stopped" });
  });

  // B5 -------------------------------------------------------------------------------------------------

  it("B5: a check left running by a stopped worker is taken back and run", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    await h.db
      .update(jobs)
      .set({ status: "running", claimedAt: hoursLater(TUESDAY_10AM_NY, -1) })
      .where(and(eq(jobs.caseId, c.id), eq(jobs.status, "pending")));
    const [result] = await due(live(fake, TUESDAY_10AM_NY), c.id);
    expect(result).toMatchObject({ outcome: "executed" });
  });

  it("B5: a case stuck in 'proposed' with an allowed action is executed; a fresh one is only rescheduled", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    const [a] = await h.db
      .insert(actions)
      .values({
        caseId: c.id,
        action: "send_reminder",
        proposedBy: "rules",
        status: "approved",
        gateVerdict: "allow",
      })
      .returning();
    await h.db
      .update(cases)
      .set({ state: "proposed", updatedAt: hoursLater(TUESDAY_10AM_NY, -0.01) })
      .where(eq(cases.id, c.id));
    const young = await runCaseCheck(live(fake, TUESDAY_10AM_NY), c.id);
    expect(young).toMatchObject({ outcome: "skipped", detail: "case is proposed" });
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(0);
    const [job] = await h.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.caseId, c.id), eq(jobs.status, "pending")));
    expect(job).toBeDefined();

    await h.db
      .update(cases)
      .set({ updatedAt: hoursLater(TUESDAY_10AM_NY, -1) })
      .where(eq(cases.id, c.id));
    const old = await runCaseCheck(live(fake, TUESDAY_10AM_NY), c.id);
    expect(old).toMatchObject({ outcome: "executed" });
    expect((await h.db.select().from(actions).where(eq(actions.id, a!.id)))[0]!.status).toBe("executed");
    expect(await caseByRef(h.db, c.paypalRef)).toMatchObject({ state: "awaiting", contacts: 1 });
  });

  // B7 -------------------------------------------------------------------------------------------------

  it("B7: a PayPal dispute naming the merchant's invoice number finds the case", async () => {
    const fake = fakePayPal();
    const number = `R-${Date.now()}`;
    const c = await openInvoiceCase(25_000, number);
    expect(c.invoiceNumber).toBe(number);
    await storeEvent(h.db, "CUSTOMER.DISPUTE.CREATED", {
      dispute_id: "PP-D-REVIEW",
      disputed_transactions: [{ invoice_number: number, seller_transaction_id: "9XY" }],
    });
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    expect((await caseByRef(h.db, c.paypalRef)).disputed).toBe(true);
    const result = await runCaseCheck(live(fake, TUESDAY_10AM_NY), c.id);
    expect(result).toMatchObject({ outcome: "closed", detail: "escalated" });
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(0);
  });

  // B8 -------------------------------------------------------------------------------------------------

  const reply = (lane: "invoice" | "subscription", ref: string, promiseDate: string) =>
    storeEvent(h.db, "BOOMERANG.CUSTOMER.REPLY", {
      paypal_ref: ref,
      lane,
      classification: "promise",
      promise_date: promiseDate,
    });

  it("B8: no proposer can contact an invoice customer before the date they promised (gate rule 13)", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    await reply("invoice", c.paypalRef, "2026-11-13");
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    // A proposer that ignores the promise and asks for a reminder anyway (as a model might).
    const pushy: Proposer = (s, d, now) => ({
      ...proposeByRules(s, { ...d, cause: "overdue_no_engagement" }, now),
      cause: d.cause,
    });
    const result = await runCaseCheck(live(fake, TUESDAY_10AM_NY, { proposer: pushy }), c.id);
    expect(result).toMatchObject({ outcome: "deferred" });
    expect(result.decision).toMatchObject({ decidedBy: 13, verdict: "block" });
    expect((await caseByRef(h.db, c.paypalRef)).nextCheckAt!.toISOString()).toBe("2026-11-14T12:00:00.000Z");
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(0);
  });

  it("B8: a subscriber's promise holds the card-update messages too", async () => {
    const fake = fakePayPal();
    const c = await openSubscriptionCase(1);
    await reply("subscription", c.paypalRef, "2026-11-12");
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    const result = await runCaseCheck(live(fake, TUESDAY_10AM_NY), c.id);
    expect(result.decision).toMatchObject({ decidedBy: 13 });
    expect(await caseByRef(h.db, c.paypalRef)).toMatchObject({ contacts: 0, state: "awaiting" });
  });

  // B10, B11, B12 --------------------------------------------------------------------------------------

  it("B10: an approval still waiting when the case is paid is cancelled, not left in the queue", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase(450_000);
    await runCaseCheck(live(fake, TUESDAY_10AM_NY), c.id);
    const [held] = await actionsOf(c.id);
    await storeEvent(h.db, "INVOICING.INVOICE.PAID", { invoice: { id: c.paypalRef, status: "PAID" } });
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    const [ap] = await h.db.select().from(approvals).where(eq(approvals.actionId, held!.id));
    expect(ap).toMatchObject({ status: "cancelled", decidedBy: "paypal" });
  });

  it("B11: running the executor again on an executed action leaves it executed", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    await runCaseCheck(live(fake, TUESDAY_10AM_NY), c.id);
    const [a] = await actionsOf(c.id);
    expect(a!.status).toBe("executed");
    const policy = await loadPolicy(h.db, "live");
    const again = await executeAction(live(fake, TUESDAY_10AM_NY), a!.id, policy);
    expect(again).toMatchObject({ outcome: "skipped" });
    expect((await actionsOf(c.id))[0]!.status).toBe("executed");
  });

  it("B12: a partial payment then the rest counts the whole invoice as recovered", async () => {
    const c = await openInvoiceCase(25_000);
    await storeEvent(h.db, "INVOICING.INVOICE.UPDATED", {
      invoice: {
        id: c.paypalRef,
        status: "PARTIALLY_PAID",
        due_amount: { currency_code: "USD", value: "100.00" },
      },
    });
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    expect(await caseByRef(h.db, c.paypalRef)).toMatchObject({ amountCents: 10_000, recoveredCents: 15_000 });
    await storeEvent(h.db, "INVOICING.INVOICE.PAID", { invoice: { id: c.paypalRef, status: "PAID" } });
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    expect(await caseByRef(h.db, c.paypalRef)).toMatchObject({
      state: "recovered",
      amountCents: 25_000,
      recoveredCents: 25_000,
    });
  });

  it("B12: a cancellation event without billing info does not wipe the balance", async () => {
    const c = await openSubscriptionCase(1);
    await storeEvent(h.db, "BILLING.SUBSCRIPTION.CANCELLED", { id: c.paypalRef, status: "CANCELLED" });
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    const after = await caseByRef(h.db, c.paypalRef);
    expect(after).toMatchObject({ closedAt: null, amountCents: 2_900, paypalStatus: "CANCELLED" });
  });

  // B14 ------------------------------------------------------------------------------------------------

  it("B14: PayPal's own pages follow PAYPAL_ENVIRONMENT", () => {
    configurePayPalWeb("PRODUCTION");
    expect(paypalPayLink({ lane: "invoice", paypalRef: "INV2-X" })).toBe(
      "https://www.paypal.com/invoice/p/#INV2-X",
    );
    configurePayPalWeb("SANDBOX");
    expect(paypalPayLink({ lane: "subscription", paypalRef: "I-X" })).toBe(
      "https://www.sandbox.paypal.com/myaccount/autopay/",
    );
  });

  it("leaves the audit chain intact", async () => {
    const v = await verifyChain(h.db, { fromId: firstAuditId });
    expect(v.ok, JSON.stringify(v)).toBe(true);
    void sql;
  });
});
