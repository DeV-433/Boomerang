import { describe, expect, it } from "vitest";
import { twoSampleBootstrap } from "../src/bootstrap";

const arm = (n: number, paidShare: number) => {
  const atRisk = Array.from({ length: n }, (_, i) => 1000 + (i % 7) * 100);
  const recovered = atRisk.map((a, i) => (i < n * paidShare ? a : 0));
  return { recovered, atRisk };
};

describe("two-sample bootstrap (9.1)", () => {
  it("brackets the observed difference in recovery rates and is reproducible", () => {
    const control = arm(150, 0.4);
    const treatment = arm(150, 0.6);
    const a = twoSampleBootstrap(control, treatment, { seed: "t" });
    const b = twoSampleBootstrap(control, treatment, { seed: "t" });
    expect(a).toEqual(b);
    expect(a.estimate).toBeGreaterThan(0.15);
    expect(a.low).toBeLessThan(a.estimate);
    expect(a.high).toBeGreaterThan(a.estimate);
    expect(a.low).toBeGreaterThan(0); // a 20-point gap on 150 cases per arm is clear of zero
    expect(a.level).toBe(0.95);
  });

  it("straddles zero when the arms are alike", () => {
    const i = twoSampleBootstrap(arm(150, 0.5), arm(150, 0.5), { seed: "same" });
    expect(i.estimate).toBeCloseTo(0, 10);
    expect(i.low).toBeLessThan(0);
    expect(i.high).toBeGreaterThan(0);
  });

  it("is wider for smaller arms", () => {
    const small = twoSampleBootstrap(arm(20, 0.4), arm(20, 0.6));
    const large = twoSampleBootstrap(arm(400, 0.4), arm(400, 0.6));
    expect(small.high - small.low).toBeGreaterThan(large.high - large.low);
  });

  it("rejects empty or mismatched arms", () => {
    expect(() => twoSampleBootstrap({ recovered: [], atRisk: [] }, arm(5, 0.5))).toThrow();
    expect(() => twoSampleBootstrap({ recovered: [1], atRisk: [1, 2] }, arm(5, 0.5))).toThrow();
  });
});
