import { eq } from "drizzle-orm";
import { actions, cases, type Database } from "@boomerang/db";
import { auditedTransaction, writeAudit } from "@boomerang/audit";
import { isEndState, lintFullMessage } from "@boomerang/core";
import { messageFacts } from "./messages";
import { closeCase, loadSnapshot, lockCase, scheduleCheck } from "./store";

export type OperatorResult =
  { ok: true; caseId: string; detail: string } | { ok: false; status: 404 | 409; error: string };

/**
 * Step 6.5 row action: pause or resume one case. A paused case is skipped by the loop; resuming
 * schedules a check right away, because a check that ran while paused did not reschedule itself.
 */
export async function setCasePaused(
  db: Database,
  caseId: string,
  paused: boolean,
  by: string,
  note?: string,
): Promise<OperatorResult> {
  return auditedTransaction(db, async (tx) => {
    const c = await lockCase(tx, caseId);
    if (!c) return { ok: false, status: 404, error: "case not found" };
    if (isEndState(c.state))
      return { ok: false, status: 409, error: `case is ${c.state}; it can no longer be paused or resumed` };
    if (c.paused === paused)
      return { ok: true, caseId, detail: paused ? "already paused" : "already running" };
    await tx.update(cases).set({ paused, updatedAt: new Date() }).where(eq(cases.id, caseId));
    await writeAudit(tx, { caseId, actor: by, kind: "system", data: { paused, note: note ?? null } });
    if (!paused && (c.state === "awaiting" || c.state === "detected"))
      await scheduleCheck(tx, caseId, new Date(), `resumed by ${by}`);
    return { ok: true, caseId, detail: paused ? "paused" : "resumed" };
  });
}

/** Step 6.5 row action: hand the case to a person now. Escalated is an end state: no more automated contact. */
export async function escalateCase(
  db: Database,
  caseId: string,
  by: string,
  note?: string,
): Promise<OperatorResult> {
  return auditedTransaction(db, async (tx) => {
    const c = await lockCase(tx, caseId);
    if (!c) return { ok: false, status: 404, error: "case not found" };
    if (isEndState(c.state)) return { ok: false, status: 409, error: `case is already ${c.state}` };
    await closeCase(tx, caseId, "escalated", note ? `escalated by ${by}: ${note}` : `escalated by ${by}`, by);
    return { ok: true, caseId, detail: "escalated" };
  });
}

/**
 * Step 6.9: an operator's edited draft must pass the same lint as any other message (amount,
 * reference, payment link, opt-out line, no invented amounts or links) before it can be approved.
 * B13: an edited subject is checked too (no threats, links, deadlines or invented facts).
 */
export async function lintEditedMessage(
  db: Database,
  actionId: string,
  body: string,
  subject?: string,
): Promise<
  { ok: true } | { ok: false; status: 404; error: string } | { ok: false; status: 422; issues: string[] }
> {
  const [row] = await db.select({ caseId: actions.caseId }).from(actions).where(eq(actions.id, actionId));
  if (!row) return { ok: false, status: 404, error: "action not found" };
  const snapshot = await loadSnapshot(db, row.caseId, new Date());
  if (!snapshot) return { ok: false, status: 404, error: "case not found" };
  const lint = lintFullMessage({ body, subject }, messageFacts(snapshot));
  return lint.ok ? { ok: true } : { ok: false, status: 422, issues: lint.issues };
}
