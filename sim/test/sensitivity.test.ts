import { describe, expect, it } from "vitest";
import { loadSimConfig, parseSimConfig, withOverrides } from "../src/config";
import { plannedArms, runSensitivity, spread, VARIATIONS } from "../src/sensitivity";

const base = loadSimConfig();

describe("sensitivity sweep (9.2)", () => {
  it("every variation yields a valid config that differs from the base (except the base)", () => {
    for (const v of VARIATIONS) {
      const c = withOverrides(base, v.apply);
      expect(() => parseSimConfig(c)).not.toThrow();
      if (v.id === "base") expect(c).toEqual(base);
      else expect(c).not.toEqual(base);
    }
  });

  it("plans the same arms for the same seed, and different arms for another seed", () => {
    const a = plannedArms(base, "s-1", 60);
    const b = plannedArms(base, "s-1", 60);
    const c = plannedArms(base, "s-2", 60);
    expect(a).toEqual(b);
    expect(a.control.length + a.treatment.length).toBe(60);
    expect(Math.abs(a.control.length - a.treatment.length)).toBeLessThanOrEqual(1);
    expect(c.control.map((x) => x.amountCents)).not.toEqual(a.control.map((x) => x.amountCents));
  });

  it("runs every variation on every seed, is reproducible, and never contacts after an opt-out", async () => {
    const variations = VARIATIONS.filter((v) => ["base", "responses-low", "more-opt-outs"].includes(v.id));
    const run = () => runSensitivity({ base, seeds: ["t-1", "t-2"], size: 40, variations });
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(a.cells).toHaveLength(6);
    expect(a.variations.map((v) => v.id)).toEqual(["base", "responses-low", "more-opt-outs"]);
    for (const v of a.variations) {
      expect(v.sameCases.min).toBeLessThanOrEqual(v.sameCases.median);
      expect(v.sameCases.median).toBeLessThanOrEqual(v.sameCases.max);
    }
    expect(a.cells.every((c) => c.contactsAfterOptOut === 0)).toBe(true);
    expect(a.overall.sameCases.min).toBe(Math.min(...a.cells.map((c) => c.upliftSameCases)));
  });

  it("summarises a spread", () => {
    expect(spread([3, -1, 2, 5])).toEqual({ min: -1, median: 2.5, max: 5, positiveShare: 0.75 });
    expect(() => spread([])).toThrow();
  });
});
