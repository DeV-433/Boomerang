import { describe, expect, it } from "vitest";
import { baselineStrategy } from "../src/baseline";
import { loadSimConfig, withOverrides } from "../src/config";
import { simulateArm, simulateCase, type SimCase } from "../src/engine";
import { planBatch } from "../src/generate";
import { computeMetrics } from "../src/metrics";
import { Rng } from "../src/rng";
import { rulesStrategy } from "../src/treatment";
import type { CustomerType } from "../src/types";

const config = loadSimConfig();
const quiet = withOverrides(config, (c) => {
  for (const t of Object.keys(c.dailySelfPay) as CustomerType[]) c.dailySelfPay[t] = 0;
});

function oneCase(
  type: CustomerType,
  lane: "invoice" | "subscription",
  visible: SimCase["visible"] = {},
  amountCents = 20_000,
): SimCase {
  return {
    caseId: `c-${type}-${lane}`,
    lane,
    amountCents,
    profile: {
      batchIndex: 7,
      lane,
      customerType: type,
      failureKind: lane === "subscription" ? "hard" : null,
    },
    visible: { timezone: "America/New_York", ...visible },
  };
}

describe("treatment arm through the simulator (4.16)", () => {
  it("runs a full seeded batch with the real gate and reports recovered dollars", async () => {
    const plan = planBatch(config, "treatment-test", 300, new Date("2026-11-09T00:00:00Z"));
    const cases = plan.cases.map((c, i) => ({
      caseId: `c${i}`,
      lane: c.profile.lane,
      amountCents: c.amountCents,
      profile: c.profile,
      visible: { reasonCode: c.subscription?.reasonCode ?? null, timezone: c.customer.timezone },
    }));
    const strategy = rulesStrategy();
    const m = computeMetrics(await simulateArm(config, new Rng("treatment-test"), cases, strategy));
    expect(m.recoveredCents).toBeGreaterThan(0);
    expect(m.contactsAfterOptOut).toBe(0); // the gate stops on opt-out
    expect(strategy.stats.escalated).toBeGreaterThan(0);
  });

  it("never contacts a case more than the cap, and never twice within the spacing gap", async () => {
    const never = withOverrides(quiet, (c) => {
      c.responses.slow_payer!.default = { pay: 0, promise: 0, dispute: 0, optOut: 0 };
      c.responses.slow_payer!.firm_reminder = { pay: 0, promise: 0, dispute: 0, optOut: 0 };
      c.responses.slow_payer!.payment_plan_offer = { pay: 0, promise: 0, dispute: 0, optOut: 0 };
    });
    const r = await simulateCase(never, new Rng("s"), oneCase("slow_payer", "invoice"), rulesStrategy());
    const days = r.timeline.filter((t) => t.event === "contact").map((t) => t.day);
    expect(days.length).toBe(3); // DEFAULT_POLICY caps.perCase
    for (let i = 1; i < days.length; i++) expect(days[i]! - days[i - 1]!).toBeGreaterThanOrEqual(2);
  });

  it("asks a hard-failure subscriber to update their card instead of waiting for retries", async () => {
    const r = await simulateCase(
      quiet,
      new Rng("s"),
      oneCase("needs_card_update", "subscription", { reasonCode: "PAYER_CANNOT_PAY" }),
      rulesStrategy(),
    );
    const first = r.timeline.find((t) => t.event === "contact");
    expect(first).toMatchObject({ day: 0, kind: "update_payment_message" });
  });

  it("waits for PayPal's retry on a soft failure before contacting", async () => {
    const r = await simulateCase(
      quiet,
      new Rng("s"),
      oneCase("would_pay_after_nudge", "subscription", { reasonCode: "INTERNAL_SERVER_ERROR" }),
      rulesStrategy(),
    );
    const first = r.timeline.find((t) => t.event === "contact");
    expect(first === undefined || first.day >= 5).toBe(true);
  });

  it("respects contact hours for a customer in Kolkata without stalling", async () => {
    const r = await simulateCase(
      quiet,
      new Rng("s"),
      oneCase("would_pay_after_nudge", "invoice", { timezone: "Asia/Kolkata" }),
      rulesStrategy(),
    );
    expect(r.timeline.some((t) => t.event === "contact")).toBe(true);
  });

  it("stops after a dispute or an opt-out, unlike the baseline", async () => {
    const optOut = withOverrides(
      quiet,
      (c) => (c.responses.opts_out!.default = { pay: 0, promise: 0, dispute: 0, optOut: 1 }),
    );
    const treated = await simulateCase(optOut, new Rng("s"), oneCase("opts_out", "invoice"), rulesStrategy());
    const baseline = await simulateCase(
      optOut,
      new Rng("s"),
      oneCase("opts_out", "invoice"),
      baselineStrategy(optOut),
    );
    expect(treated.contacts).toBe(1);
    expect(treated.contactsAfterOptOut).toBe(0);
    expect(baseline.contactsAfterOptOut).toBeGreaterThan(0);
  });

  it("holds a high-value case for approval and contacts it the next day", async () => {
    const r = await simulateCase(
      quiet,
      new Rng("s"),
      oneCase("slow_payer", "invoice", {}, 450_000),
      rulesStrategy(),
    );
    expect(r.timeline.find((t) => t.event === "contact")?.day).toBe(1);
  });
});
