import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "@boomerang/policy";
import { pairedBootstrap, percentile } from "../src/bootstrap";
import type { CaseResult } from "../src/engine";
import { applyOverrides, diffReplays, PolicyOverridesSchema, type ReplayResult } from "../src/replay";

const caseResult = (
  caseId: string,
  amountCents: number,
  recoveredCents: number,
  contacts: number,
  outcome: CaseResult["outcome"],
): CaseResult => ({
  caseId,
  lane: "invoice",
  amountCents,
  recoveredCents,
  recoveredDay: recoveredCents ? 3 : null,
  contacts,
  contactsAfterOptOut: 0,
  outcome,
  timeline: [],
});
const asReplay = (results: CaseResult[], escalated: number): ReplayResult => {
  const atRisk = results.reduce((s, r) => s + r.amountCents, 0);
  const recovered = results.reduce((s, r) => s + r.recoveredCents, 0);
  return {
    policy: DEFAULT_POLICY,
    results,
    stats: { escalated, stopped: 0, heldForApproval: 0, gateBlocks: {} },
    fingerprint: "x",
    metrics: {
      cases: results.length,
      atRiskCents: atRisk,
      recoveredCents: recovered,
      recoveredCases: results.filter((r) => r.recoveredCents > 0).length,
      recoveryRate: recovered / atRisk,
      contacts: results.reduce((s, r) => s + r.contacts, 0),
      contactsPerRecoveredDollar: null,
      medianDaysToRecovery: null,
      disputes: 0,
      optOuts: 0,
      contactsAfterOptOut: 0,
      payPageUses: 0,
      payPagePayments: 0,
      payPagePromises: 0,
      escalated,
      stopped: 0,
      heldForApproval: 0,
    },
  };
};

describe("what-if diff (7A.5)", () => {
  it("is correct on a hand-built example", () => {
    const base = asReplay(
      [
        caseResult("a", 10_000, 10_000, 1, "recovered"),
        caseResult("b", 20_000, 0, 3, "unrecovered"),
        caseResult("c", 30_000, 30_000, 2, "recovered"),
        caseResult("d", 40_000, 0, 1, "opted_out"),
      ],
      2,
    );
    const scenario = asReplay(
      [
        caseResult("a", 10_000, 10_000, 1, "recovered"),
        caseResult("b", 20_000, 20_000, 4, "recovered"),
        caseResult("c", 30_000, 0, 1, "unrecovered"),
        caseResult("d", 40_000, 0, 1, "opted_out"),
      ],
      1,
    );
    expect(diffReplays(base, scenario)).toEqual({
      recoveredCents: { base: 40_000, scenario: 30_000, delta: -10_000 },
      recoveryRate: { base: 0.4, scenario: 0.3, deltaPoints: expect.closeTo(-10, 9) },
      contacts: { base: 7, scenario: 7, delta: 0 },
      escalations: { base: 2, scenario: 1, delta: -1 },
      contactsAfterOptOut: { base: 0, scenario: 0, delta: 0 },
      casesChanged: 2,
      casesNewlyRecovered: 1,
      casesNoLongerRecovered: 1,
    });
  });

  it("refuses replays of different cases", () => {
    const a = asReplay([caseResult("a", 1, 0, 0, "unrecovered")], 0);
    const b = asReplay([caseResult("z", 1, 0, 0, "unrecovered")], 0);
    expect(() => diffReplays(a, b)).toThrow(/same case order/);
  });
});

describe("policy overrides (7A.4)", () => {
  it("changes only the settings given, and validates ranges", () => {
    const p = applyOverrides(DEFAULT_POLICY, {
      perCase: 1,
      hoursStart: 8,
      approvalAmountCents: 50_000,
      contactDays: [5, 1, 1],
    });
    expect(p.caps).toEqual({ perCase: 1, perCustomerPerWeek: DEFAULT_POLICY.caps.perCustomerPerWeek });
    expect(p.hours).toMatchObject({ start: 8, end: DEFAULT_POLICY.hours.end, days: [1, 5] });
    expect(p.thresholds).toEqual({ ...DEFAULT_POLICY.thresholds, approvalAmountCents: 50_000 });
    expect(DEFAULT_POLICY.caps.perCase).toBe(3); // the base is not mutated
    expect(PolicyOverridesSchema.safeParse({ perCase: 0 }).success).toBe(false);
    expect(PolicyOverridesSchema.safeParse({ hoursStart: 18, hoursEnd: 9 }).success).toBe(false);
    expect(PolicyOverridesSchema.safeParse({ dropTables: true }).success).toBe(false);
    expect(() => applyOverrides(DEFAULT_POLICY, { hoursStart: 19 })).toThrow(/empty/);
  });
});

describe("bootstrap interval (7A.6)", () => {
  it("collapses to the estimate when every case changes by the same amount", () => {
    const r = pairedBootstrap([1, 2, 3, 4], [6, 7, 8, 9], { iterations: 500 });
    expect(r.sum).toMatchObject({ estimate: 20, low: 20, high: 20, level: 0.95, iterations: 500 });
  });

  it("is centred near the true difference with the textbook width on known data", () => {
    // 400 cases: the scenario recovers 100 more on half of them, 0 on the rest.
    // Sum of differences = 20,000; bootstrap sd of the sum = sqrt(n) * sd(diff) = 20 * 50 = 1,000.
    const base = Array.from({ length: 400 }, () => 0);
    const scenario = Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? 100 : 0));
    const r = pairedBootstrap(base, scenario, { iterations: 4000, seed: "known" });
    expect(r.sum.estimate).toBe(20_000);
    expect(r.sum.low).toBeGreaterThan(20_000 - 1.96 * 1000 * 1.15);
    expect(r.sum.low).toBeLessThan(20_000 - 1.96 * 1000 * 0.85);
    expect(r.sum.high).toBeGreaterThan(20_000 + 1.96 * 1000 * 0.85);
    expect(r.sum.high).toBeLessThan(20_000 + 1.96 * 1000 * 1.15);
  });

  it("is seeded (same input, same interval) and reports a rate interval with weights", () => {
    const base = [0, 50, 0, 100, 0];
    const scen = [100, 50, 0, 100, 40];
    const w = [100, 100, 100, 100, 100];
    const a = pairedBootstrap(base, scen, { weights: w, seed: "s" });
    const b = pairedBootstrap(base, scen, { weights: w, seed: "s" });
    expect(a).toEqual(b);
    expect(a.rate!.estimate).toBeCloseTo(140 / 500);
  });

  it("interpolates percentiles", () => {
    expect(percentile([0, 10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([0, 10], 0.25)).toBe(2.5);
  });
});
