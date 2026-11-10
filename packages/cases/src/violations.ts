import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { isContactAction, isSensitiveAction, type Action } from "@boomerang/core";
import { actions, approvals, cases, customers, events, type Database } from "@boomerang/db";
import { contactWindow, localTime, type Policy } from "@boomerang/policy";

/** One action that broke a policy rule. `rule` is the gate rule number it breaks (0: no gate allowed it). */
export interface Violation {
  rule: number;
  name: string;
  caseId: string;
  detail: string;
  runId?: string;
  actionId?: string;
}

const H = 3_600_000;

/**
 * Step 9.4, live half: re-checks every executed action (live or dry run) from the stored facts,
 * independently of the gate that let it through. A violation here means the gate, the executor or
 * an approval path let something past a rule. The result must be empty.
 */
export async function liveViolations(
  db: Database,
  policy: Policy,
): Promise<{ checked: number; contacts: number; violations: Violation[] }> {
  const rows = await db
    .select({
      id: actions.id,
      caseId: actions.caseId,
      action: actions.action,
      gateVerdict: actions.gateVerdict,
      executedAt: actions.executedAt,
      closedAt: cases.closedAt,
      customerId: cases.customerId,
      optedOutAt: customers.optedOutAt,
      timezone: customers.timezone,
      approval: approvals.status,
      approvedAt: approvals.decidedAt,
    })
    .from(actions)
    .innerJoin(cases, eq(cases.id, actions.caseId))
    .innerJoin(customers, eq(customers.id, cases.customerId))
    .leftJoin(approvals, eq(approvals.actionId, actions.id))
    .where(and(eq(actions.status, "executed"), isNotNull(actions.executedAt)))
    .orderBy(asc(actions.executedAt));

  // When each case first saw a dispute: PayPal's dispute event or a reply classified as one.
  const caseIds = [...new Set(rows.map((r) => r.caseId))];
  const disputes = caseIds.length
    ? await db
        .select({ caseId: events.caseId, at: sql<Date>`min(${events.receivedAt})` })
        .from(events)
        .where(
          and(
            inArray(events.caseId, caseIds),
            or(
              sql`${events.type} like 'CUSTOMER.DISPUTE.%'`,
              sql`${events.type} = 'BOOMERANG.CUSTOMER.REPLY' and ${events.payload}->'resource'->>'classification' = 'dispute'`,
            ),
          ),
        )
        .groupBy(events.caseId)
    : [];
  const disputedAt = new Map(disputes.map((d) => [d.caseId!, new Date(d.at)]));

  const out: Violation[] = [];
  const contactsByCase = new Map<string, Date[]>();
  const contactsByCustomer = new Map<string, Date[]>();
  let contacts = 0;
  for (const r of rows) {
    const at = r.executedAt!;
    const v = (rule: number, name: string, detail: string) =>
      out.push({ rule, name, caseId: r.caseId, actionId: r.id, detail: `${r.action}: ${detail}` });
    const approved = r.approval === "approved" || r.approval === "edited";
    if (r.gateVerdict !== "allow" && !approved)
      v(0, "not_allowed", `executed with gate verdict ${r.gateVerdict ?? "none"} and no approval`);
    if (isSensitiveAction(r.action as Action)) {
      if (!approved || !r.approvedAt || r.approvedAt > at)
        v(12, "sensitive_action", "moved money without a person's approval before it ran");
    }
    if (!isContactAction(r.action as Action)) continue;
    contacts++;
    if (r.closedAt && r.closedAt <= at)
      v(1, "already_resolved", `sent ${at.toISOString()} after the case closed`);
    const d = disputedAt.get(r.caseId);
    if (d && d <= at) v(2, "dispute_open", `sent after a dispute on ${d.toISOString()}`);
    if (r.optedOutAt && r.optedOutAt <= at) v(3, "opted_out", `sent after the customer opted out`);

    const onCase = contactsByCase.get(r.caseId) ?? [];
    const last = onCase[onCase.length - 1];
    if (last && at.getTime() - last.getTime() < policy.thresholds.minGapHours * H)
      v(7, "spacing", `${((at.getTime() - last.getTime()) / H).toFixed(1)} hours after the previous contact`);
    onCase.push(at);
    contactsByCase.set(r.caseId, onCase);
    if (onCase.length > policy.caps.perCase)
      v(6, "attempt_cap", `contact ${onCase.length} on this case, over the cap of ${policy.caps.perCase}`);
    const byCustomer = (contactsByCustomer.get(r.customerId) ?? []).filter(
      (t) => at.getTime() - t.getTime() < 7 * 24 * H,
    );
    byCustomer.push(at);
    contactsByCustomer.set(r.customerId, byCustomer);
    if (byCustomer.length > policy.caps.perCustomerPerWeek)
      v(6, "attempt_cap", `contact ${byCustomer.length} to this customer within 7 days`);

    const w = contactWindow({ customerTimezone: r.timezone, policy });
    const { hour, weekday } = localTime(at, w.timeZone);
    if (!w.days.includes(weekday) || hour < w.start || hour >= w.end)
      v(8, "contact_hours", `sent at ${hour}:00 (weekday ${weekday}) in ${w.timeZone}`);
  }
  return { checked: rows.length, contacts, violations: out };
}
