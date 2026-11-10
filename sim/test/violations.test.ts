import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "@boomerang/policy";
import { baselineStrategy } from "../src/baseline";
import { loadSimConfig } from "../src/config";
import type { TimelineEntry } from "../src/engine";
import { simulateArm } from "../src/engine";
import { Rng } from "../src/rng";
import { plannedArms } from "../src/sensitivity";
import { rulesStrategy } from "../src/treatment";
import { timelineViolations } from "../src/violations";

type Outcome = "ignore" | "pay" | "promise" | "dispute" | "opt_out";
const contact = (day: number, outcome: Outcome = "ignore", afterOptOut = false): TimelineEntry => ({
  day,
  event: "contact",
  kind: "targeted_reminder",
  outcome,
  afterOptOut,
});
const rules = (t: TimelineEntry[]) => timelineViolations("c", t).map((v) => v.rule);

describe("zero-violation check on simulated timelines (9.4)", () => {
  it("passes a timeline that keeps every rule", () => {
    expect(rules([contact(0), contact(3), { day: 4, event: "paid", via: "contact" }])).toEqual([]);
  });

  it("flags each rule a contact can break", () => {
    expect(rules([contact(0, "opt_out"), contact(3, "ignore", true)])).toEqual([3]);
    expect(rules([contact(0, "dispute"), contact(3)])).toEqual([2]);
    expect(rules([{ day: 1, event: "paid", via: "self" }, contact(3)])).toEqual([1]);
    expect(rules([contact(0), contact(1)])).toEqual([7]);
    expect(rules([contact(0), contact(2), contact(4), contact(6)])).toEqual([6]);
    expect(rules([{ day: 0, event: "paypal_failure_notice", outcome: "opt_out" }, contact(2)])).toEqual([3]);
  });

  it("finds the baseline's contacts after opt-out, and none in Boomerang's run of the same cases", async () => {
    const config = loadSimConfig();
    const { treatment } = plannedArms(config, "violations-check", 120);
    const rng = new Rng("violations-check");
    const all = async (s: Parameters<typeof simulateArm>[3]) =>
      (await simulateArm(config, rng, treatment, s)).flatMap((r) =>
        timelineViolations(r.caseId, r.timeline, DEFAULT_POLICY),
      );
    const baseline = await all(baselineStrategy(config));
    expect(baseline.some((v) => v.rule === 3)).toBe(true); // the checker is not vacuous
    expect(await all(rulesStrategy())).toEqual([]);
  });
});
