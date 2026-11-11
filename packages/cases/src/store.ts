import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { auditedTransaction, writeAudit } from "@boomerang/audit";
import { isEndState, transition, type CaseState } from "@boomerang/core";
import {
  actions,
  approvals,
  cases,
  customers,
  jobs,
  policies,
  systemState,
  type Database,
} from "@boomerang/db";
import { DEFAULT_POLICY, type Policy } from "@boomerang/policy";
import type { CaseSnapshot } from "./diagnose";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Db = Database | Tx;

export const MERCHANT_ID = "default";

/** Locks the case row for the rest of the transaction. */
export async function lockCase(tx: Tx, caseId: string) {
  const [row] = await tx.select().from(cases).where(eq(cases.id, caseId)).for("update");
  return row ?? null;
}

/** Moves a case to a new state, enforcing the state machine. */
export async function setState(
  tx: Tx,
  caseId: string,
  from: CaseState,
  to: CaseState,
  extra: Parameters<ReturnType<Tx["update"]>["set"]>[0] = {},
) {
  transition(from, to);
  await tx
    .update(cases)
    .set({ ...extra, state: to, updatedAt: sql`now()` })
    .where(eq(cases.id, caseId));
}

/**
 * Customer-facing messages to this customer in the 7 days before `now`, across all their cases.
 * B9: dry runs count too, so a dry run walks the same stages, caps and spacing a live run would
 * (after a switch to live, the week before is counted conservatively).
 */
export async function customerContactsLast7Days(db: Db, customerId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 7 * 24 * 3_600_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(actions)
    .innerJoin(cases, eq(cases.id, actions.caseId))
    .where(
      and(
        eq(cases.customerId, customerId),
        eq(actions.status, "executed"),
        inArray(actions.action, ["send_reminder", "offer_payment_plan", "send_update_payment_message"]),
        gte(actions.executedAt, since),
      ),
    );
  return row?.n ?? 0;
}

export async function loadSnapshot(db: Db, caseId: string, now: Date): Promise<CaseSnapshot | null> {
  const [row] = await db
    .select({ c: cases, customer: customers })
    .from(cases)
    .innerJoin(customers, eq(customers.id, cases.customerId))
    .where(eq(cases.id, caseId));
  if (!row) return null;
  const { c, customer } = row;
  return {
    id: c.id,
    lane: c.lane,
    amountCents: c.amountCents,
    currency: c.currency,
    paypalRef: c.paypalRef,
    contacts: c.contacts,
    lastContactAt: c.lastContactAt,
    openedAt: c.openedAt,
    paypalStatus: c.paypalStatus,
    dueDate: c.dueDate,
    failedPayments: c.failedPayments,
    lastFailureReason: c.lastFailureReason,
    paymentUpdatedAt: c.paymentUpdatedAt,
    promiseDate: c.promiseDate,
    disputed: c.disputed,
    optedOut: customer.optedOut,
    customerName: customer.name,
    customerTimezone: customer.timezone,
    customerContactsLast7Days: await customerContactsLast7Days(db, customer.id, now),
  };
}

/** Cancels every pending job for the case (4.14: stopping a case removes its pending jobs). */
export async function cancelJobs(tx: Db, caseId: string): Promise<number> {
  const cancelled = await tx
    .update(jobs)
    .set({ status: "cancelled", finishedAt: sql`now()` })
    .where(and(eq(jobs.caseId, caseId), eq(jobs.status, "pending")))
    .returning({ id: jobs.id });
  return cancelled.length;
}

/** Ensures exactly one pending check for the case, at `runAt` (replacing any other pending one). */
export async function scheduleCheck(tx: Tx, caseId: string, runAt: Date, reason: string): Promise<void> {
  await cancelJobs(tx, caseId);
  await tx.insert(jobs).values({ caseId, kind: "check_case", runAt, reason });
  await tx.update(cases).set({ nextCheckAt: runAt }).where(eq(cases.id, caseId));
}

/**
 * Ends a case: final state, close reason, recovered amount, pending jobs and approvals cancelled,
 * audit entry. No-op if the case already ended (end states are final; a late event cannot reopen
 * or recount it).
 *
 * B12: while a case is open, `recoveredCents` holds partial payments already received and
 * `amountCents` what is still due. At close the case's amount goes back to the original total, and
 * money that came in is never zeroed: a recovered case counts everything, any other end keeps the
 * partial payments.
 */
export async function closeCase(
  tx: Tx,
  caseId: string,
  endState: "recovered" | "stopped" | "escalated",
  reason: string,
  actor: string,
  options: { recoveredCents?: number; at?: Date } = {},
): Promise<boolean> {
  const current = await lockCase(tx, caseId);
  if (!current || isEndState(current.state)) return false;
  const total = current.amountCents + current.recoveredCents;
  const recoveredCents =
    endState === "recovered" ? (options.recoveredCents ?? total) : current.recoveredCents;
  const at = options.at ?? new Date();
  await setState(tx, caseId, current.state, endState, {
    closedAt: at,
    closeReason: reason,
    amountCents: total,
    recoveredCents,
    nextCheckAt: null,
  });
  const cancelled = await tx
    .update(actions)
    .set({ status: "cancelled" })
    .where(and(eq(actions.caseId, caseId), inArray(actions.status, ["proposed", "held", "approved"])))
    .returning({ id: actions.id });
  // B10: an approval still waiting for a person is moot once the case is closed.
  const cancelledApprovals = cancelled.length
    ? await tx
        .update(approvals)
        .set({ status: "cancelled", decidedBy: actor, decidedAt: at, note: `case ${endState}: ${reason}` })
        .where(
          and(
            inArray(
              approvals.actionId,
              cancelled.map((a) => a.id),
            ),
            eq(approvals.status, "pending"),
          ),
        )
        .returning({ id: approvals.id })
    : [];
  const cancelledJobs = await cancelJobs(tx, caseId);
  await writeAudit(tx, {
    caseId,
    actor,
    kind: "closed",
    data: {
      endState,
      reason,
      recoveredCents,
      fromState: current.state,
      cancelledJobs,
      ...(cancelledApprovals.length ? { cancelledApprovals: cancelledApprovals.length } : {}),
    },
    at: options.at,
  });
  return true;
}

/** The merchant's current policy, creating version 1 from the defaults on first use. */
export async function loadPolicy(db: Database, modeOverride?: "dry_run" | "live"): Promise<Policy> {
  const [row] = await db
    .select()
    .from(policies)
    .where(eq(policies.merchantId, MERCHANT_ID))
    .orderBy(desc(policies.version))
    .limit(1);
  let policy: Policy;
  if (row) {
    policy = {
      version: row.version,
      mode: row.mode,
      caps: row.caps as Policy["caps"],
      hours: row.hours as Policy["hours"],
      thresholds: row.thresholds as Policy["thresholds"],
    };
  } else {
    await db
      .insert(policies)
      .values({
        merchantId: MERCHANT_ID,
        version: DEFAULT_POLICY.version,
        mode: DEFAULT_POLICY.mode,
        caps: DEFAULT_POLICY.caps,
        hours: DEFAULT_POLICY.hours,
        thresholds: DEFAULT_POLICY.thresholds,
      })
      .onConflictDoNothing();
    policy = DEFAULT_POLICY;
  }
  // POLICY_MODE from the environment wins, so a deployment can be forced into dry run.
  return modeOverride ? { ...policy, mode: modeOverride } : policy;
}

export async function isSystemPaused(db: Db): Promise<boolean> {
  const [row] = await db.select().from(systemState).where(eq(systemState.id, 1));
  return row?.paused ?? false;
}

/** B15: the worker records its POLICY_MODE (at start and on every tick) for the API to read. */
export async function reportWorkerMode(db: Database, mode: "dry_run" | "live"): Promise<void> {
  await db
    .insert(systemState)
    .values({ id: 1, workerMode: mode, workerSeenAt: sql`now()` })
    .onConflictDoUpdate({ target: systemState.id, set: { workerMode: mode, workerSeenAt: sql`now()` } });
}

/**
 * B15: the mode an approved action runs in when the API executes it. Live only when the API and the
 * worker are both live, so an API left in live mode cannot send while the worker is in a dry run.
 */
export async function effectiveMode(
  db: Db,
  apiMode: "dry_run" | "live",
): Promise<{
  mode: "dry_run" | "live";
  apiMode: "dry_run" | "live";
  workerMode: "dry_run" | "live" | null;
  workerSeenAt: Date | null;
}> {
  const [row] = await db
    .select({ workerMode: systemState.workerMode, workerSeenAt: systemState.workerSeenAt })
    .from(systemState)
    .where(eq(systemState.id, 1));
  const workerMode = row?.workerMode ?? null;
  return {
    mode: apiMode === "live" && workerMode === "live" ? "live" : "dry_run",
    apiMode,
    workerMode,
    workerSeenAt: row?.workerSeenAt ?? null,
  };
}

export async function setSystemPaused(db: Database, paused: boolean, by: string): Promise<void> {
  await auditedTransaction(db, async (tx) => {
    await tx
      .insert(systemState)
      .values({ id: 1, paused, pausedBy: by })
      .onConflictDoUpdate({ target: systemState.id, set: { paused, pausedBy: by, changedAt: sql`now()` } });
    await writeAudit(tx, { caseId: null, actor: by, kind: "system", data: { paused } });
  });
}
