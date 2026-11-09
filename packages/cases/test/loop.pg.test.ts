import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { verifyChain } from "@boomerang/audit";
import { actions, approvals, auditLog, batches, cases, jobs, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import { processPendingEvents } from "../src/events";
import { executeAction } from "../src/executor";
import { runDueJobs } from "../src/jobs";
import { decideApproval, runCaseCheck, startBatch, type LoopDeps } from "../src/loop";
import { pollInvoices } from "../src/poller";
import { closeCase, loadPolicy, setSystemPaused } from "../src/store";
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

describe.skipIf(!hasTestDb)("the core loop without AI (Phase 4)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await setupTestDb();
    await setSystemPaused(h.db, false, "test");
  });
  afterAll(async () => {
    await setSystemPaused(h.db, false, "test");
    await h?.close();
  });

  /** Opens an overdue invoice case through the real path: overdue event -> case opener. */
  async function openInvoiceCase(cents = 25_000, at = TUESDAY_10AM_NY) {
    const id = invoiceId();
    await storeEvent(
      h.db,
      "BOOMERANG.INVOICE.OVERDUE",
      { invoice: overdueInvoice(id, cents) },
      { source: "poll" },
    );
    await processPendingEvents(h.db, { now: () => at });
    const c = await caseByRef(h.db, id);
    await setCustomerTimezone(h.db, c.customerId, "America/New_York");
    return c;
  }

  /** Runs due jobs for just these cases: the test database is shared with other test files. */
  const due = (deps: LoopDeps, ...ids: string[]) => runDueJobs(deps, { caseIds: ids });
  const live = (fake: ReturnType<typeof fakePayPal>, now: Date): LoopDeps => ({
    db: h.db,
    gateway: fake.gateway,
    mode: "live",
    now: () => now,
  });
  const trailKinds = async (caseId: string) =>
    (
      await h.db
        .select({ kind: auditLog.kind })
        .from(auditLog)
        .where(eq(auditLog.caseId, caseId))
        .orderBy(asc(auditLog.id))
    ).map((r) => r.kind);
  const pendingJobs = (caseId: string) =>
    h.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.caseId, caseId), eq(jobs.status, "pending")));

  // 4.12 + 4.15 path 1 (CP3): detected -> recovered with gate and audit, no model involved.
  it("takes an overdue invoice from detected to recovered with a gated, logged reminder", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    expect(c.state).toBe("detected");
    expect(await pendingJobs(c.id)).toHaveLength(1);

    const [result] = await due(live(fake, TUESDAY_10AM_NY), c.id);
    expect(result).toMatchObject({ outcome: "executed", detail: "send_reminder" });

    // PayPal saw: re-read of the invoice, cancel of its own auto-reminders, then our reminder with an idempotency key.
    expect(fake.calls.map((x) => x.tool)).toEqual([
      "get_invoice",
      "cancel_invoice_auto_reminder",
      "send_invoice_reminder",
    ]);
    const remind = tool(fake, "send_invoice_reminder")[0]!;
    expect(remind.args).toMatchObject({ invoice_id: c.paypalRef });
    expect(remind.requestId).toBe(`${c.id}:send_reminder:0`);

    const after = await caseByRef(h.db, c.paypalRef);
    expect(after).toMatchObject({ state: "awaiting", contacts: 1, cause: "overdue_no_engagement" });
    const [action] = await h.db.select().from(actions).where(eq(actions.caseId, c.id));
    expect(action).toMatchObject({
      status: "executed",
      gateVerdict: "allow",
      idempotencyKey: `${c.id}:send_reminder:0`,
    });
    expect(await pendingJobs(c.id)).toHaveLength(1); // follow-up in 72 h

    // The customer pays: PayPal's webhook closes the case as recovered and cancels the follow-up.
    await storeEvent(h.db, "INVOICING.INVOICE.PAID", { invoice: { id: c.paypalRef, status: "PAID" } });
    await processPendingEvents(h.db, { now: () => hoursLater(TUESDAY_10AM_NY, 5) });
    const closed = await caseByRef(h.db, c.paypalRef);
    expect(closed).toMatchObject({ state: "recovered", recoveredCents: 25_000 });
    expect(await pendingJobs(c.id)).toHaveLength(0);

    expect(await trailKinds(c.id)).toEqual([
      "event_received",
      "diagnosed",
      "proposed",
      "gated",
      "executed",
      "event_received",
      "closed",
    ]);
    const [first] = await h.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.caseId, c.id))
      .orderBy(asc(auditLog.id))
      .limit(1);
    expect((await verifyChain(h.db, { fromId: first!.id })).ok).toBe(true);
  });

  // 4.15 path 2: no reply moves the case to the next stage.
  it("moves an unanswered case to the next stage at its next check", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase(80_000);
    await runCaseCheck(live(fake, TUESDAY_10AM_NY), c.id);
    const checkAt = (await caseByRef(h.db, c.paypalRef)).nextCheckAt!;
    expect(checkAt.getTime()).toBe(hoursLater(TUESDAY_10AM_NY, 72).getTime());

    // Nothing happens before the check is due...
    expect((await due(live(fake, hoursLater(TUESDAY_10AM_NY, 71)), c.id))[0]).toBeUndefined();
    // ...then the second stage: no reply on a larger amount, so a payment plan offer.
    const [second] = await due(live(fake, hoursLater(TUESDAY_10AM_NY, 72)), c.id);
    expect(second).toMatchObject({ outcome: "executed", detail: "offer_payment_plan" });
    expect(await caseByRef(h.db, c.paypalRef)).toMatchObject({
      contacts: 2,
      cause: "overdue_unresponsive",
      state: "awaiting",
    });
    expect(tool(fake, "cancel_invoice_auto_reminder")).toHaveLength(1); // only on Boomerang's first contact
    expect(tool(fake, "send_invoice_reminder").map((x) => x.requestId)).toEqual([
      `${c.id}:send_reminder:0`,
      `${c.id}:offer_payment_plan:1`,
    ]);
  });

  // 4.13
  it("sends nothing when the payment event lands between the gate and the call", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    const deps = live(fake, TUESDAY_10AM_NY);
    // Gate allows the reminder; stop just before execution by gating through the dry path, then re-arm.
    const [action] = await h.db
      .insert(actions)
      .values({
        caseId: c.id,
        action: "send_reminder",
        proposedBy: "rules",
        status: "approved",
        gateVerdict: "allow",
      })
      .returning();
    await h.db.update(cases).set({ state: "proposed" }).where(eq(cases.id, c.id));

    // The paid webhook is processed first...
    await storeEvent(h.db, "INVOICING.INVOICE.PAID", { invoice: { id: c.paypalRef, status: "PAID" } });
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    // ...so the executor finds the case recovered and sends nothing.
    const result = await executeAction(deps, action!.id, await loadPolicy(h.db, "live"));
    expect(result.outcome).toBe("cancelled");
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(0);
    expect((await caseByRef(h.db, c.paypalRef)).state).toBe("recovered");
  });

  it("sends nothing when PayPal itself already shows the invoice paid (webhook not yet arrived)", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    fake.invoiceStatus.set(c.paypalRef, "MARKED_AS_PAID");
    const result = await runCaseCheck(live(fake, TUESDAY_10AM_NY), c.id);
    expect(result.outcome).toBe("cancelled");
    expect(fake.calls.map((x) => x.tool)).toEqual(["get_invoice"]);
    expect(await caseByRef(h.db, c.paypalRef)).toMatchObject({ state: "recovered", recoveredCents: 25_000 });
  });

  // 4.14
  it("cancels a case's pending jobs when it stops", async () => {
    const c = await openInvoiceCase();
    expect(await pendingJobs(c.id)).toHaveLength(1);
    await h.db.transaction((tx) => closeCase(tx, c.id, "stopped", "operator stopped it", "operator:test"));
    expect(await pendingJobs(c.id)).toHaveLength(0);
    expect((await due(live(fakePayPal(), hoursLater(TUESDAY_10AM_NY, 500)), c.id))[0]).toBeUndefined();
  });

  it("stops on an opt-out reply, and the gate records rule 3", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    await storeEvent(
      h.db,
      "BOOMERANG.CUSTOMER.REPLY",
      { paypal_ref: c.paypalRef, lane: "invoice", classification: "opt_out" },
      { simulated: true },
    );
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    const [result] = await due(live(fake, TUESDAY_10AM_NY), c.id);
    expect(result).toMatchObject({ outcome: "closed" });
    expect(await caseByRef(h.db, c.paypalRef)).toMatchObject({ state: "stopped" });
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(0);
    expect(await pendingJobs(c.id)).toHaveLength(0);
  });

  it("escalates on a dispute and records a promise without contacting", async () => {
    const fake = fakePayPal();
    const disputed = await openInvoiceCase();
    await storeEvent(h.db, "CUSTOMER.DISPUTE.CREATED", {
      dispute_id: "PP-D-1",
      disputed_transactions: [{ invoice_number: disputed.paypalRef }],
    });
    const promised = await openInvoiceCase();
    await storeEvent(
      h.db,
      "BOOMERANG.CUSTOMER.REPLY",
      {
        paypal_ref: promised.paypalRef,
        lane: "invoice",
        classification: "promise",
        promise_date: "2026-11-14",
      },
      { simulated: true },
    );
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    await due(live(fake, TUESDAY_10AM_NY), disputed.id, promised.id);
    expect((await caseByRef(h.db, disputed.paypalRef)).state).toBe("escalated");
    const p = await caseByRef(h.db, promised.paypalRef);
    expect(p).toMatchObject({ state: "awaiting", cause: "promise_to_pay", contacts: 0 });
    expect(p.nextCheckAt!.toISOString().slice(0, 10)).toBe("2026-11-15");
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(0);
  });

  it("holds outside contact hours and sends once the window opens", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    await setCustomerTimezone(h.db, c.customerId, "Asia/Kolkata"); // 20:30 there
    const [first] = await due(live(fake, TUESDAY_10AM_NY), c.id);
    expect(first).toMatchObject({ outcome: "deferred" });
    expect((await caseByRef(h.db, c.paypalRef)).nextCheckAt!.toISOString()).toBe("2026-11-11T03:30:00.000Z");
    const [second] = await due(live(fake, new Date("2026-11-11T03:30:00Z")), c.id);
    expect(second).toMatchObject({ outcome: "executed" });
  });

  it("holds a high-value case for approval, then sends once a person approves", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase(450_000);
    const held = await runCaseCheck(live(fake, TUESDAY_10AM_NY), c.id);
    expect(held).toMatchObject({ outcome: "held" });
    expect((await caseByRef(h.db, c.paypalRef)).state).toBe("approval");
    const [action] = await h.db.select().from(actions).where(eq(actions.caseId, c.id));
    expect(await h.db.select().from(approvals).where(eq(approvals.actionId, action!.id))).toHaveLength(1);
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(0);

    const approved = await decideApproval(live(fake, TUESDAY_10AM_NY), action!.id, {
      approve: true,
      by: "operator:test",
    });
    expect(approved).toMatchObject({ outcome: "executed" });
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(1);
    expect((await h.db.select().from(approvals).where(eq(approvals.actionId, action!.id)))[0]!.status).toBe(
      "approved",
    );
  });

  it("sends nothing and checks again shortly when PayPal cannot be reached for the pre-send re-check", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase(450_000);
    await runCaseCheck(live(fake, TUESDAY_10AM_NY), c.id);
    const [action] = await h.db.select().from(actions).where(eq(actions.caseId, c.id));
    fake.failGetInvoice.set(c.paypalRef, 503);
    const approved = await decideApproval(live(fake, TUESDAY_10AM_NY), action!.id, {
      approve: true,
      by: "operator:test",
    });
    expect(approved).toMatchObject({ outcome: "deferred" });
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(0);
    expect((await h.db.select().from(actions).where(eq(actions.id, action!.id)))[0]!.status).toBe("failed");
    expect(await caseByRef(h.db, c.paypalRef)).toMatchObject({ state: "awaiting" });
    const [job] = await pendingJobs(c.id);
    expect(job!.runAt.toISOString()).toBe(hoursLater(TUESDAY_10AM_NY, 0.25).toISOString());

    // PayPal is back: the next check goes through the gate again (and holds the high-value case for a person again).
    fake.failGetInvoice.delete(c.paypalRef);
    const [again] = await due(live(fake, hoursLater(TUESDAY_10AM_NY, 0.25)), c.id);
    expect(again).toMatchObject({ outcome: "held" });
  });

  it("stops a case, sending nothing, when PayPal no longer has the invoice at send time", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    fake.failGetInvoice.set(c.paypalRef, 404);
    const [result] = await due(live(fake, TUESDAY_10AM_NY), c.id);
    expect(result).toMatchObject({ outcome: "closed" });
    expect(await caseByRef(h.db, c.paypalRef)).toMatchObject({ state: "stopped" });
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(0);
  });

  it("stops a case when a person rejects the held action", async () => {
    const c = await openInvoiceCase(450_000);
    await runCaseCheck(live(fakePayPal(), TUESDAY_10AM_NY), c.id);
    const [action] = await h.db.select().from(actions).where(eq(actions.caseId, c.id));
    await decideApproval(live(fakePayPal(), TUESDAY_10AM_NY), action!.id, {
      approve: false,
      by: "operator:test",
      note: "customer is a partner",
    });
    expect(await caseByRef(h.db, c.paypalRef)).toMatchObject({
      state: "stopped",
      closeReason: "rejected by operator:test: customer is a partner",
    });
  });

  it("defers everything while the kill switch is on", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    await setSystemPaused(h.db, true, "operator:test");
    try {
      const result = await runCaseCheck(live(fake, TUESDAY_10AM_NY), c.id);
      expect(result.outcome).toBe("deferred");
      expect(result.decision?.decidedBy).toBe(4);
      expect(tool(fake, "send_invoice_reminder")).toHaveLength(0);
    } finally {
      await setSystemPaused(h.db, false, "operator:test");
    }
  });

  it("in dry-run mode records what it would send and calls nothing that changes PayPal", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    const result = await runCaseCheck({ ...live(fake, TUESDAY_10AM_NY), mode: "dry_run" }, c.id);
    expect(result).toMatchObject({ outcome: "dry_run", detail: "send_invoice_reminder" });
    expect(fake.calls.map((x) => x.tool)).toEqual(["get_invoice"]); // read-only re-check only
    const [action] = await h.db.select().from(actions).where(eq(actions.caseId, c.id));
    expect(action!.toolCall).toMatchObject({
      dryRun: true,
      tool: "send_invoice_reminder",
      invoiceId: c.paypalRef,
    });
    expect((await caseByRef(h.db, c.paypalRef)).contacts).toBe(0);
  });

  it("never works control-arm cases or cases of a batch that has not started", async () => {
    const fake = fakePayPal();
    const [batch] = await h.db
      .insert(batches)
      .values({ name: "t", seed: `loop-${Date.now()}`, size: 2, mode: "offline", simConfig: {} })
      .returning();
    const control = await openInvoiceCase();
    const treatment = await openInvoiceCase();
    await h.db
      .update(cases)
      .set({ batchId: batch!.id, experimentGroup: "control" })
      .where(eq(cases.id, control.id));
    await h.db
      .update(cases)
      .set({ batchId: batch!.id, experimentGroup: "treatment" })
      .where(eq(cases.id, treatment.id));

    let ran = (await due(live(fake, TUESDAY_10AM_NY), control.id, treatment.id)).map((r) => r.caseId);
    expect(ran).not.toContain(control.id);
    expect(ran).not.toContain(treatment.id); // batch not started

    expect(await startBatch(h.db, batch!.id, TUESDAY_10AM_NY)).toBe(1);
    ran = (await due(live(fake, TUESDAY_10AM_NY), control.id, treatment.id)).map((r) => r.caseId);
    expect(ran).toContain(treatment.id);
    expect(ran).not.toContain(control.id);
  });

  it("works the subscription lane: soft failure waits for PayPal, a hard failure asks for a card update", async () => {
    const fake = fakePayPal();
    const soft = `I-SOFT${Date.now()}`;
    const hard = `I-HARD${Date.now()}`;
    const failed = (id: string, reason: string) => ({
      id,
      status: "ACTIVE",
      subscriber: { payer_id: `P${id}`, email_address: `${id}@example.com` },
      billing_info: {
        failed_payments_count: 1,
        outstanding_balance: { currency_code: "USD", value: "29.00" },
        last_failed_payment: { reason_code: reason },
      },
    });
    await storeEvent(h.db, "BILLING.SUBSCRIPTION.PAYMENT.FAILED", failed(soft, "INTERNAL_SERVER_ERROR"));
    await storeEvent(h.db, "BILLING.SUBSCRIPTION.PAYMENT.FAILED", failed(hard, "PAYER_CANNOT_PAY"));
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    for (const ref of [soft, hard])
      await setCustomerTimezone(h.db, (await caseByRef(h.db, ref)).customerId, "America/New_York");
    await due(
      live(fake, TUESDAY_10AM_NY),
      (await caseByRef(h.db, soft)).id,
      (await caseByRef(h.db, hard)).id,
    );

    expect(await caseByRef(h.db, soft)).toMatchObject({
      state: "awaiting",
      cause: "temporary_decline",
      contacts: 0,
    });
    const hardCase = await caseByRef(h.db, hard);
    expect(hardCase).toMatchObject({ state: "awaiting", cause: "expired_funding_source", contacts: 1 });
    const [msg] = await h.db.select().from(actions).where(eq(actions.caseId, hardCase.id));
    expect(msg!.toolCall).toMatchObject({ channel: "log" }); // no PayPal tool messages subscribers

    // PayPal's retry succeeds for the soft one.
    await storeEvent(h.db, "PAYMENT.SALE.COMPLETED", {
      id: "SALE-1",
      billing_agreement_id: soft,
      amount: { total: "29.00" },
    });
    await processPendingEvents(h.db, { now: () => hoursLater(TUESDAY_10AM_NY, 120) });
    expect(await caseByRef(h.db, soft)).toMatchObject({ state: "recovered", recoveredCents: 2900 });
  });

  // 4.4
  it("the overdue poller opens one case per past-due invoice, not two, and catches missed payments", async () => {
    const fake = fakePayPal();
    const id = invoiceId();
    fake.invoices.push(overdueInvoice(id, 31_000), {
      ...overdueInvoice(invoiceId(), 5_000),
      detail: { currency_code: "USD", payment_term: { due_date: "2099-01-01" } },
    });
    const poll = () =>
      pollInvoices({
        db: h.db,
        gateway: fake.gateway,
        merchantTimezone: "America/New_York",
        now: () => TUESDAY_10AM_NY,
      });
    const first = await poll();
    const second = await poll();
    expect(first.overdue).toBeGreaterThanOrEqual(1);
    expect(second.eventsStored).toBe(0);
    expect(await h.db.select().from(cases).where(eq(cases.paypalRef, id))).toHaveLength(1);
    expect(await caseByRef(h.db, id)).toMatchObject({
      amountCents: 31_000,
      state: "detected",
      dueDate: "2026-10-30",
    });

    // The paid webhook never arrives, but the next poll sees the invoice paid.
    fake.invoices[0] = { ...overdueInvoice(id, 31_000), status: "PAID" };
    await poll();
    expect(await caseByRef(h.db, id)).toMatchObject({
      state: "recovered",
      closeReason: "PayPal reports PAID",
    });
  });
});
