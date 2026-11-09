import { describe, expect, it } from "vitest";
import type { CaseResult } from "../src/engine";
import { compareArms, computeMetrics, median } from "../src/metrics";

function result(partial: Partial<CaseResult> & Pick<CaseResult, "amountCents">): CaseResult {
  return {
    caseId: "c",
    lane: "invoice",
    recoveredCents: 0,
    recoveredDay: null,
    contacts: 0,
    contactsAfterOptOut: 0,
    outcome: "unrecovered",
    timeline: [],
    ...partial,
  };
}

describe("metrics (3.8), checked against hand calculations", () => {
  // Four cases, $1,000 at risk:
  //   $400 recovered on day 2 after 1 contact
  //   $100 recovered on day 10 after 3 contacts
  //   $300 disputed after 2 contacts
  //   $200 never paid after 4 contacts, 2 of them after opting out
  const results = [
    result({ amountCents: 40_000, recoveredCents: 40_000, recoveredDay: 2, contacts: 1, outcome: "recovered" }),
    result({ amountCents: 10_000, recoveredCents: 10_000, recoveredDay: 10, contacts: 3, outcome: "recovered" }),
    result({ amountCents: 30_000, contacts: 2, outcome: "disputed" }),
    result({ amountCents: 20_000, contacts: 4, contactsAfterOptOut: 2, outcome: "opted_out" }),
  ];
  const m = computeMetrics(results);

  it("sums amounts at risk and recovered", () => {
    expect(m.atRiskCents).toBe(100_000); // $1,000
    expect(m.recoveredCents).toBe(50_000); // $400 + $100
    expect(m.recoveredCases).toBe(2);
  });

  it("computes the recovery rate", () => {
    expect(m.recoveryRate).toBe(0.5); // $500 / $1,000
  });

  it("computes contacts per recovered dollar", () => {
    expect(m.contacts).toBe(10); // 1 + 3 + 2 + 4
    expect(m.contactsPerRecoveredDollar).toBeCloseTo(0.02, 10); // 10 / $500
  });

  it("computes median time to recovery over recovered cases only", () => {
    expect(m.medianDaysToRecovery).toBe(6); // median of [2, 10]
  });

  it("counts disputes, opt-outs and contacts after opt-out", () => {
    expect([m.disputes, m.optOuts, m.contactsAfterOptOut]).toEqual([1, 1, 2]);
  });

  it("handles an arm where nothing was recovered", () => {
    const none = computeMetrics([result({ amountCents: 5000, contacts: 2 })]);
    expect(none.recoveryRate).toBe(0);
    expect(none.contactsPerRecoveredDollar).toBeNull();
    expect(none.medianDaysToRecovery).toBeNull();
  });

  it("computes uplift as treatment rate minus control rate", () => {
    const treatment = [
      result({ amountCents: 10_000, recoveredCents: 10_000, recoveredDay: 1, outcome: "recovered" }),
      result({ amountCents: 10_000, recoveredCents: 10_000, recoveredDay: 3, outcome: "recovered" }),
      result({ amountCents: 10_000, recoveredCents: 10_000, recoveredDay: 5, outcome: "recovered" }),
      result({ amountCents: 10_000 }),
    ];
    expect(compareArms(results, treatment).uplift).toBeCloseTo(0.75 - 0.5, 10);
  });

  it("median handles odd, even and empty lists", () => {
    expect([median([3, 1, 2]), median([4, 1, 3, 2]), median([])]).toEqual([2, 2.5, null]);
  });
});
