import { describe, expect, it } from "vitest";
import { baselineStrategy } from "../src/baseline";
import { loadSimConfig, withOverrides } from "../src/config";
import { simulateArm, simulateCase, type SimCase, type Strategy } from "../src/engine";
import { planBatch } from "../src/generate";
import { computeMetrics } from "../src/metrics";
import { Rng } from "../src/rng";
import type { CustomerType } from "../src/types";

const config = loadSimConfig();
const silent: Strategy = { name: "silent", contactsFor: () => [] };

function oneCase(
  type: CustomerType,
  lane: "invoice" | "subscription" = "invoice",
  failureKind: "soft" | "hard" | null = null,
): SimCase {
  return {
    caseId: "c1",
    lane,
    amountCents: 10_000,
    profile: { batchIndex: 1, lane, customerType: type, failureKind },
  };
}

/** Config where nothing random happens unless a test turns it on. */
const quiet = withOverrides(config, (c) => {
  for (const t of Object.keys(c.dailySelfPay) as CustomerType[]) c.dailySelfPay[t] = 0;
});

describe("simulation engine and baseline (3.7)", () => {
  it("is deterministic for the same seed", async () => {
    const plan = planBatch(config, "engine-test", 120, new Date("2026-11-09T00:00:00Z"));
    const cases = plan.cases.map((c, i) => ({
      caseId: `c${i}`,
      lane: c.profile.lane,
      amountCents: c.amountCents,
      profile: c.profile,
    }));
    const a = await simulateArm(config, new Rng("engine-test"), cases, baselineStrategy(config));
    const b = await simulateArm(config, new Rng("engine-test"), cases, baselineStrategy(config));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("baseline sends generic reminders exactly on the configured days until payment", async () => {
    const never = withOverrides(quiet, (c) => {
      c.responses.slow_payer!.default = { pay: 0, promise: 0, dispute: 0, optOut: 0 };
    });
    const r = await simulateCase(never, new Rng("s"), oneCase("slow_payer"), baselineStrategy(never));
    const days = r.timeline.filter((t) => t.event === "contact").map((t) => t.day);
    expect(days).toEqual(never.baseline.invoiceReminderDays);
    expect(r.outcome).toBe("unrecovered");
    expect(r.contacts).toBe(never.baseline.invoiceReminderDays.length);
  });

  it("baseline keeps contacting after an opt-out, and the engine counts it", async () => {
    const alwaysOptOut = withOverrides(quiet, (c) => {
      c.responses.opts_out!.default = { pay: 0, promise: 0, dispute: 0, optOut: 1 };
    });
    const r = await simulateCase(
      alwaysOptOut,
      new Rng("s"),
      oneCase("opts_out"),
      baselineStrategy(alwaysOptOut),
    );
    expect(r.outcome).toBe("opted_out");
    expect(r.contactsAfterOptOut).toBe(alwaysOptOut.baseline.invoiceReminderDays.length - 1);
  });

  it("a kept promise pays on the promised day", async () => {
    const promiser = withOverrides(quiet, (c) => {
      c.responses.promises_then_pays!.payment_plan_offer = { pay: 0, promise: 1, dispute: 0, optOut: 0 };
      c.promise.keepProbability.promises_then_pays = 1;
      c.promise.inDays = { min: 4, max: 4 };
    });
    const once: Strategy = {
      name: "once",
      contactsFor: ({ day }) => (day === 2 ? ["payment_plan_offer"] : []),
    };
    const r = await simulateCase(promiser, new Rng("s"), oneCase("promises_then_pays"), once);
    expect(r.recoveredDay).toBe(6);
    expect(r.timeline.at(-1)).toEqual({ day: 6, event: "paid", via: "promise" });
  });

  it("a dispute ends any chance of recovery", async () => {
    const disputer = withOverrides(quiet, (c) => {
      c.responses.disputer!.default = { pay: 0, promise: 0, dispute: 1, optOut: 0 };
    });
    const r = await simulateCase(disputer, new Rng("s"), oneCase("disputer"), baselineStrategy(disputer));
    expect(r.outcome).toBe("disputed");
    expect(r.recoveredCents).toBe(0);
  });

  it("PayPal retries a soft failure on its own schedule and can recover it with no contact at all", async () => {
    const sure = withOverrides(quiet, (c) => (c.paypalRetry.softSuccessProbability = 1));
    const r = await simulateCase(
      sure,
      new Rng("s"),
      oneCase("would_pay_after_nudge", "subscription", "soft"),
      silent,
    );
    expect(r.recoveredDay).toBe(sure.paypalRetry.intervalDays);
    expect(r.contacts).toBe(0);
  });

  it("PayPal retries never fix a hard failure, and the subscription is suspended at the threshold", async () => {
    const deaf = withOverrides(quiet, (c) => {
      c.responses.needs_card_update!.paypal_failure_notice = { pay: 0, promise: 0, dispute: 0, optOut: 0 };
    });
    const r = await simulateCase(
      deaf,
      new Rng("s"),
      oneCase("needs_card_update", "subscription", "hard"),
      silent,
    );
    expect(r.outcome).toBe("unrecovered");
    const retries = r.timeline.filter((t) => t.event === "paypal_retry");
    expect(retries).toHaveLength(deaf.paypalRetry.maxRetriesPerCycle);
    expect(retries.every((t) => t.event === "paypal_retry" && !t.success)).toBe(true);
    expect(r.timeline.some((t) => t.event === "suspended")).toBe(true);
  });

  it("a card update lets the next PayPal retry succeed", async () => {
    const fixer = withOverrides(quiet, (c) => {
      c.responses.needs_card_update!.update_payment_message = { pay: 1, promise: 0, dispute: 0, optOut: 0 };
      c.payDelayDays = { min: 30, max: 30 }; // the retry on day 5 beats paying through the link
      c.paypalRetry.afterCardUpdateSuccessProbability = 1;
    });
    const ask: Strategy = {
      name: "ask",
      contactsFor: ({ day }) => (day === 1 ? ["update_payment_message"] : []),
    };
    const r = await simulateCase(
      fixer,
      new Rng("s"),
      oneCase("needs_card_update", "subscription", "hard"),
      ask,
    );
    expect(r.recoveredDay).toBe(5);
    expect(r.timeline.at(-1)).toMatchObject({ event: "paid", via: "paypal_retry" });
  });

  it("a full 300-case baseline batch recovers some, not all, of the money", async () => {
    const plan = planBatch(config, "baseline-batch", 300, new Date("2026-11-09T00:00:00Z"));
    const cases = plan.cases.map((c, i) => ({
      caseId: `c${i}`,
      lane: c.profile.lane,
      amountCents: c.amountCents,
      profile: c.profile,
    }));
    const m = computeMetrics(
      await simulateArm(config, new Rng("baseline-batch"), cases, baselineStrategy(config)),
    );
    expect(m.recoveredCents).toBeGreaterThan(0);
    expect(m.recoveryRate).toBeLessThan(1);
    expect(m.contactsAfterOptOut).toBeGreaterThan(0); // the fixed schedule ignores opt-outs
  });
});
