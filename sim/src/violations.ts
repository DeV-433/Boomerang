import { and, eq, isNotNull, like } from "drizzle-orm";
import { liveViolations, type Violation } from "@boomerang/cases";
import { simCaseResults, simRuns, type Database } from "@boomerang/db";
import { DEFAULT_POLICY, type Policy } from "@boomerang/policy";
import type { TimelineEntry } from "./engine";

const DAY_HOURS = 24;

/**
 * Step 9.4, simulated half: checks one case's recorded timeline from a Boomerang run against the
 * rules a contact must obey. Days are whole simulated days, so a check only flags what the
 * timeline proves: two contacts one day apart are always under 48 hours apart.
 * The baseline breaks these rules by design (it ignores replies) and is not checked.
 */
export function timelineViolations(
  caseId: string,
  timeline: readonly TimelineEntry[],
  policy: Pick<Policy, "caps" | "thresholds"> = DEFAULT_POLICY,
): Violation[] {
  const out: Violation[] = [];
  const v = (rule: number, name: string, detail: string) => out.push({ rule, name, caseId, detail });
  let paidDay: number | null = null;
  let optOutDay: number | null = null;
  let disputeDay: number | null = null;
  const contactDays: number[] = [];
  for (const t of timeline) {
    if (t.event === "paid" && paidDay === null) paidDay = t.day;
    if (t.event === "contact") {
      if (paidDay !== null && t.day >= paidDay)
        v(1, "already_resolved", `contact on day ${t.day} after payment on day ${paidDay}`);
      if (disputeDay !== null && t.day > disputeDay)
        v(2, "dispute_open", `contact on day ${t.day} after a dispute on day ${disputeDay}`);
      if (t.afterOptOut || (optOutDay !== null && t.day > optOutDay))
        v(
          3,
          "opted_out",
          `contact on day ${t.day} after an opt-out${optOutDay !== null ? ` on day ${optOutDay}` : ""}`,
        );
      const last = contactDays[contactDays.length - 1];
      const minGapDays = Math.ceil(policy.thresholds.minGapHours / DAY_HOURS);
      if (last !== undefined && t.day - last < minGapDays)
        v(
          7,
          "spacing",
          `contacts on days ${last} and ${t.day}, under ${policy.thresholds.minGapHours} hours apart`,
        );
      contactDays.push(t.day);
      if (contactDays.length > policy.caps.perCase)
        v(
          6,
          "attempt_cap",
          `contact ${contactDays.length} on day ${t.day}, over the cap of ${policy.caps.perCase}`,
        );
    }
    // A reply to a contact (or to PayPal's failure notice) takes effect from that day.
    if (
      (t.event === "contact" || t.event === "paypal_failure_notice") &&
      t.outcome === "opt_out" &&
      optOutDay === null
    )
      optOutDay = t.day;
    if (
      (t.event === "contact" || t.event === "paypal_failure_notice") &&
      t.outcome === "dispute" &&
      disputeDay === null
    )
      disputeDay = t.day;
  }
  return out;
}

export interface ViolationReport {
  checkedAt: string;
  simulated: { runs: number; cases: number; contacts: number; violations: Violation[] };
  live: { actions: number; contacts: number; violations: Violation[] };
  /** Violations by gate rule number, both halves together. */
  byRule: Record<string, number>;
  total: number;
}

/**
 * Step 9.4: every Boomerang run stored in sim_case_results (baseline runs excluded: they ignore
 * replies by design) plus every executed live or dry-run action. The total must be zero.
 */
export async function violationReport(
  db: Database,
  policy: Policy,
  now: Date = new Date(),
): Promise<ViolationReport> {
  const runs = await db
    .select({ id: simRuns.id })
    .from(simRuns)
    .where(and(isNotNull(simRuns.finishedAt), like(simRuns.strategy, "boomerang%")));
  const simViolations: Violation[] = [];
  let cases = 0;
  let contacts = 0;
  for (const run of runs) {
    const results = await db
      .select({
        caseId: simCaseResults.caseId,
        timeline: simCaseResults.timeline,
        contacts: simCaseResults.contacts,
      })
      .from(simCaseResults)
      .where(eq(simCaseResults.runId, run.id));
    for (const r of results) {
      cases++;
      contacts += r.contacts;
      for (const v of timelineViolations(r.caseId, r.timeline as TimelineEntry[], policy))
        simViolations.push({ ...v, runId: run.id });
    }
  }
  const live = await liveViolations(db, policy);
  const all = [...simViolations, ...live.violations];
  const byRule: Record<string, number> = {};
  for (const v of all) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
  return {
    checkedAt: now.toISOString(),
    simulated: { runs: runs.length, cases, contacts, violations: simViolations },
    live: { actions: live.checked, contacts: live.contacts, violations: live.violations },
    byRule,
    total: all.length,
  };
}
