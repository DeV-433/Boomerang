import { describe, expect, it } from "vitest";
import { loadSimConfig } from "../src/config";
import { amountBand, assignArms } from "../src/assign";
import { planBatch } from "../src/generate";

describe("stratified assignment (3.5)", () => {
  const plan = planBatch(loadSimConfig(), "assign-test", 300, new Date("2026-11-09T00:00:00Z"));
  const items = plan.cases.map((c, i) => ({ id: `c${i}`, lane: c.profile.lane, amountCents: c.amountCents }));
  const arms = assignArms(items, "assign-test");

  const arm = (name: string) => items.filter((i) => arms.get(i.id) === name);
  const dollars = (xs: typeof items) => xs.reduce((s, x) => s + x.amountCents, 0);

  it("assigns every case to exactly one arm", () => {
    expect(arms.size).toBe(items.length);
  });

  it("gives both arms similar size and similar dollars at risk", () => {
    const c = arm("control");
    const t = arm("treatment");
    expect(Math.abs(c.length - t.length)).toBeLessThanOrEqual(1);
    const ratio = dollars(c) / dollars(t);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it("balances every lane and amount band", () => {
    for (const lane of ["invoice", "subscription"]) {
      for (let band = 0; band <= 3; band++) {
        const stratum = items.filter((i) => i.lane === lane && amountBand(i.amountCents) === band);
        const control = stratum.filter((i) => arms.get(i.id) === "control").length;
        expect(Math.abs(2 * control - stratum.length), `${lane} band ${band}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is reproducible and depends on the seed", () => {
    expect([...assignArms(items, "assign-test")]).toEqual([...arms]);
    expect([...assignArms(items, "other-seed")]).not.toEqual([...arms]);
  });

  it("bands amounts at $100, $500 and $2,000", () => {
    expect([9999, 10000, 49999, 50000, 199999, 200000].map(amountBand)).toEqual([0, 1, 1, 2, 2, 3]);
  });
});
