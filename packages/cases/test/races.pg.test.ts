import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { verifyChain } from "@boomerang/audit";
import { actions, approvals, auditLog, cases, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import { processPendingEvents } from "../src/events";
import { executeAction } from "../src/executor";
import { decideApproval, runCaseCheck, type LoopDeps } from "../src/loop";
import { loadPolicy, setSystemPaused } from "../src/store";
import {
  caseByRef,
  fakePayPal,
  invoiceId,
  overdueInvoice,
  setCustomerTimezone,
  storeEvent,
  tool,
  TUESDAY_10AM_NY,
} from "./helpers";

/**
 * Step 9.5: idempotency and races. Each scenario runs the competing operations at the same time
 * (Promise.all against a real Postgres) and checks there is exactly one outcome.
 */
describe.skipIf(!hasTestDb)("idempotency and races (9.5)", () => {
  let h: DbHandle;
  /** The shared test database holds deliberately tampered entries (trust panel tests): verify from here on. */
  let chainFrom = 0;
  beforeAll(async () => {
    h = await setupTestDb();
    await setSystemPaused(h.db, false, "test");
    const [last] = await h.db.select({ id: auditLog.id }).from(auditLog).orderBy(desc(auditLog.id)).limit(1);
    chainFrom = (last?.id ?? 0) + 1;
  });
  afterAll(async () => {
    await h?.close();
  });

  const live = (fake: ReturnType<typeof fakePayPal>): LoopDeps => ({
    db: h.db,
    gateway: fake.gateway,
    mode: "live",
    now: () => TUESDAY_10AM_NY,
  });
  async function openInvoiceCase(cents = 25_000) {
    const id = invoiceId();
    await storeEvent(
      h.db,
      "BOOMERANG.INVOICE.OVERDUE",
      { invoice: overdueInvoice(id, cents) },
      { source: "poll" },
    );
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    const c = await caseByRef(h.db, id);
    await setCustomerTimezone(h.db, c.customerId, "America/New_York");
    return c;
  }
  const kinds = async (caseId: string, kind: string) =>
    (
      await h.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.caseId, caseId), eq(auditLog.kind, kind)))
    ).length;
  /** Recorded decisions on a held action (the hold itself writes a "pending" approval entry). */
  const decisions = async (caseId: string) =>
    (
      await h.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.caseId, caseId),
            eq(auditLog.kind, "approval"),
            sql`${auditLog.data}->>'status' <> 'pending'`,
          ),
        )
    ).length;

  it("two paid events for one invoice, processed by two workers at once, close it once and count the money once", async () => {
    const c = await openInvoiceCase();
    const paid = { invoice: { id: c.paypalRef, status: "PAID" } };
    await storeEvent(h.db, "INVOICING.INVOICE.PAID", paid);
    await storeEvent(h.db, "INVOICING.INVOICE.PAID", paid); // PayPal re-sent it under a new event id
    await Promise.all([
      processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY }),
      processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY }),
    ]);
    expect(await caseByRef(h.db, c.paypalRef)).toMatchObject({ state: "recovered", recoveredCents: 25_000 });
    expect(await kinds(c.id, "closed")).toBe(1);
  });

  it("two workers checking the same case at the same moment send one reminder", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    const results = await Promise.all([runCaseCheck(live(fake), c.id), runCaseCheck(live(fake), c.id)]);
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "executed")).toHaveLength(1);
    const sent = await h.db
      .select()
      .from(actions)
      .where(and(eq(actions.caseId, c.id), eq(actions.status, "executed")));
    expect(sent).toHaveLength(1);
  });

  async function heldCase(fake: ReturnType<typeof fakePayPal>) {
    const c = await openInvoiceCase(450_000); // over the approval threshold
    expect(await runCaseCheck(live(fake), c.id)).toMatchObject({ outcome: "held" });
    const [action] = await h.db.select().from(actions).where(eq(actions.caseId, c.id));
    return { c, actionId: action!.id };
  }

  it("a double click on Approve sends once and records one decision", async () => {
    const fake = fakePayPal();
    const { c, actionId } = await heldCase(fake);
    const approve = () => decideApproval(live(fake), actionId, { approve: true, by: "operator:test" });
    const results = await Promise.all([approve(), approve(), approve()]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["executed", "skipped", "skipped"]);
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(1);
    expect(await decisions(c.id)).toBe(1);
  });

  it("Approve and Reject clicked at once: exactly one wins", async () => {
    const fake = fakePayPal();
    const { c, actionId } = await heldCase(fake);
    const results = await Promise.all([
      decideApproval(live(fake), actionId, { approve: true, by: "operator:a" }),
      decideApproval(live(fake), actionId, { approve: false, by: "operator:b" }),
    ]);
    expect(results.filter((r) => r.outcome !== "skipped")).toHaveLength(1);
    const [approval] = await h.db.select().from(approvals).where(eq(approvals.actionId, actionId));
    const sends = tool(fake, "send_invoice_reminder").length;
    if (approval!.status === "approved") expect(sends).toBe(1);
    else {
      expect(approval!.status).toBe("rejected");
      expect(sends).toBe(0);
      expect((await caseByRef(h.db, c.paypalRef)).state).toBe("stopped");
    }
    expect(await decisions(c.id)).toBe(1);
  });

  it("running the executor twice on one action (a retry after a crash) calls PayPal once", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
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
    const policy = await loadPolicy(h.db, "live");
    await Promise.all([
      executeAction(live(fake), action!.id, policy),
      executeAction(live(fake), action!.id, policy),
    ]);
    expect(tool(fake, "send_invoice_reminder")).toHaveLength(1);
    expect(await kinds(c.id, "executed")).toBe(1);
    expect((await caseByRef(h.db, c.paypalRef)).contacts).toBe(1);
  });

  it("the same in dry-run mode: one record, one contact counted", async () => {
    const c = await openInvoiceCase();
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
    const deps: LoopDeps = { db: h.db, mode: "dry_run", now: () => TUESDAY_10AM_NY };
    const policy = await loadPolicy(h.db, "dry_run");
    const results = await Promise.all([
      executeAction(deps, action!.id, policy),
      executeAction(deps, action!.id, policy),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["dry_run", "skipped"]);
    expect(await kinds(c.id, "executed")).toBe(1);
  });

  it("a payment arriving while the case is being checked never leads to a reminder after it closed", async () => {
    const fake = fakePayPal();
    const c = await openInvoiceCase();
    await storeEvent(h.db, "INVOICING.INVOICE.PAID", { invoice: { id: c.paypalRef, status: "PAID" } });
    await Promise.all([
      runCaseCheck(live(fake), c.id),
      processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY }),
    ]);
    const closed = await caseByRef(h.db, c.paypalRef);
    expect(closed).toMatchObject({ state: "recovered", recoveredCents: 25_000 });
    // Either the reminder went out before the payment was recorded, or not at all; never twice.
    const sends = tool(fake, "send_invoice_reminder");
    expect(sends.length).toBeLessThanOrEqual(1);
    const [sent] = await h.db
      .select()
      .from(actions)
      .where(and(eq(actions.caseId, c.id), eq(actions.status, "executed")));
    if (sent) expect(sent.executedAt!.getTime()).toBeLessThanOrEqual(closed.closedAt!.getTime());
  });

  it("leaves the audit chain intact after all of the above", async () => {
    const r = await verifyChain(h.db, { fromId: chainFrom });
    expect(r.ok).toBe(true);
  });
});
