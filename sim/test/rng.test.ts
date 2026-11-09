import { describe, expect, it } from "vitest";
import { loadSimConfig } from "../src/config";
import { planBatch } from "../src/generate";
import { Rng } from "../src/rng";

describe("seeded random generator (3.2)", () => {
  it("gives identical output for the same seed and keys", () => {
    const a = new Rng("seed-42");
    const b = new Rng("seed-42");
    const draws = (r: Rng) => Array.from({ length: 50 }, (_, i) => r.draw("case", i, "purpose"));
    expect(draws(a)).toEqual(draws(b));
    expect(a.shuffle([1, 2, 3, 4, 5, 6], "s")).toEqual(b.shuffle([1, 2, 3, 4, 5, 6], "s"));
  });

  it("gives different output for a different seed", () => {
    expect(new Rng("a").draw("x")).not.toBe(new Rng("b").draw("x"));
  });

  it("does not depend on draw order", () => {
    const r = new Rng("s");
    const first = r.draw("case-7", "pay", 3);
    r.draw("case-1", "noise");
    r.draw("case-2", "noise");
    expect(r.draw("case-7", "pay", 3)).toBe(first);
  });

  it("produces a byte-identical batch plan from the same seed", () => {
    const config = loadSimConfig();
    const now = new Date("2026-11-09T00:00:00Z");
    const a = JSON.stringify(planBatch(config, "demo-1", 300, now));
    const b = JSON.stringify(planBatch(config, "demo-1", 300, now));
    expect(a).toBe(b);
    expect(JSON.stringify(planBatch(config, "demo-2", 300, now))).not.toBe(a);
  });

  it("weighted picks follow the weights", () => {
    const r = new Rng("w");
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 4000; i++) counts[r.weighted({ a: 0.8, b: 0.2 }, i)]++;
    expect(counts.a / 4000).toBeGreaterThan(0.77);
    expect(counts.a / 4000).toBeLessThan(0.83);
  });
});
