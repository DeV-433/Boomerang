import type { CaseResult } from "./engine";

export interface ArmMetrics {
  cases: number;
  atRiskCents: number;
  recoveredCents: number;
  recoveredCases: number;
  /** Recovered dollars divided by dollars at risk. */
  recoveryRate: number;
  contacts: number;
  /** Messages sent per recovered dollar; lower is better. Null when nothing was recovered. */
  contactsPerRecoveredDollar: number | null;
  /** Median days from detection to payment, over recovered cases. */
  medianDaysToRecovery: number | null;
  disputes: number;
  optOuts: number;
  /** Messages sent to customers who had already opted out. Must be zero for Boomerang. */
  contactsAfterOptOut: number;
  /** 7C.7: customers who acted on the self-serve pay page (paid, updated a card, or promised a date). */
  payPageUses: number;
  /** Cases paid directly on the pay page. */
  payPagePayments: number;
  /** Promises made on the pay page. */
  payPagePromises: number;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Step 3.8: the numbers the brief asks for, computed from per-case results. */
export function computeMetrics(results: readonly CaseResult[]): ArmMetrics {
  const atRiskCents = results.reduce((s, r) => s + r.amountCents, 0);
  const recoveredCents = results.reduce((s, r) => s + r.recoveredCents, 0);
  const contacts = results.reduce((s, r) => s + r.contacts, 0);
  const recoveredDays = results.flatMap((r) => (r.recoveredDay === null ? [] : [r.recoveredDay]));
  return {
    cases: results.length,
    atRiskCents,
    recoveredCents,
    recoveredCases: recoveredDays.length,
    recoveryRate: atRiskCents === 0 ? 0 : recoveredCents / atRiskCents,
    contacts,
    contactsPerRecoveredDollar: recoveredCents === 0 ? null : contacts / (recoveredCents / 100),
    medianDaysToRecovery: median(recoveredDays),
    disputes: results.filter((r) => r.outcome === "disputed").length,
    optOuts: results.filter(
      (r) =>
        r.outcome === "opted_out" || r.timeline.some((t) => t.event === "contact" && t.outcome === "opt_out"),
    ).length,
    contactsAfterOptOut: results.reduce((s, r) => s + r.contactsAfterOptOut, 0),
    payPageUses: results.filter((r) => r.timeline.some((t) => t.event === "page")).length,
    payPagePayments: results.filter((r) => r.timeline.some((t) => t.event === "paid" && t.via === "page"))
      .length,
    payPagePromises: results.reduce(
      (s, r) => s + r.timeline.filter((t) => t.event === "page" && t.action === "promise").length,
      0,
    ),
  };
}

export interface ArmComparison {
  control: ArmMetrics;
  treatment: ArmMetrics;
  /** Treatment recovery rate minus control recovery rate. */
  uplift: number;
}

export function compareArms(control: readonly CaseResult[], treatment: readonly CaseResult[]): ArmComparison {
  const c = computeMetrics(control);
  const t = computeMetrics(treatment);
  return { control: c, treatment: t, uplift: t.recoveryRate - c.recoveryRate };
}

/** Same metrics split by lane, for the dashboard. */
export function metricsByLane(results: readonly CaseResult[]): Record<string, ArmMetrics> {
  const lanes = [...new Set(results.map((r) => r.lane))];
  return Object.fromEntries(
    lanes.map((lane) => [lane, computeMetrics(results.filter((r) => r.lane === lane))]),
  );
}
