import { describe, expect, it } from "vitest";
import { loadSimConfig } from "../src/config";
import { simulateArm, type SimCase, type Strategy } from "../src/engine";
import { computeMetrics } from "../src/metrics";
import { Rng } from "../src/rng";

const config = loadSimConfig();
const cases: SimCase[] = Array.from({ length: 300 }, (_, i) => ({
  caseId: `case-${i}`,
  lane: i % 3 === 0 ? "subscription" : "invoice",
  amountCents: 10_000,
  profile: {
    batchIndex: i,
    lane: i % 3 === 0 ? "subscription" : "invoice",
    customerType: i % 2 ? "slow_payer" : "would_pay_after_nudge",
    failureKind: i % 3 === 0 ? "hard" : null,
  },
}));
/** One targeted reminder on days 1 and 6: enough contacts for the page to matter. */
const reminders = (carriesPayPage: boolean): Strategy => ({
  name: "test",
  carriesPayPage,
  contactsFor: (v) =>
    [1, 6].includes(v.day) ? [v.lane === "invoice" ? "targeted_reminder" : "update_payment_message"] : [],
});

describe("simulated customers can use the pay page (7C.7)", () => {
  it("records page payments, card updates and promises, and they show in the batch results", async () => {
    const results = await simulateArm(config, new Rng("page-seed"), cases, reminders(true));
    const m = computeMetrics(results);
    expect(m.payPageUses).toBeGreaterThan(0);
    expect(m.payPagePayments).toBeGreaterThan(0);
    expect(m.payPagePromises).toBeGreaterThan(0);
    const events = results.flatMap((r) =>
      r.timeline.filter((t) => t.event === "page").map((t) => ({ lane: r.lane, t })),
    );
    // Subscribers update their card on the page; only invoices are paid there directly.
    expect(
      events
        .filter((e) => e.lane === "subscription")
        .every((e) => e.t.event === "page" && e.t.action !== "pay"),
    ).toBe(true);
  });

  it("does nothing for strategies without the link, or for batches whose config predates it", async () => {
    const without = computeMetrics(await simulateArm(config, new Rng("page-seed"), cases, reminders(false)));
    expect(without.payPageUses).toBe(0);
    const { payPage: _drop, ...oldConfig } = config;
    const old = computeMetrics(await simulateArm(oldConfig, new Rng("page-seed"), cases, reminders(true)));
    expect(old.payPageUses).toBe(0);
  });

  it("raises recovery under the configured assumptions, deterministically", async () => {
    const a = computeMetrics(await simulateArm(config, new Rng("page-seed"), cases, reminders(true)));
    const b = computeMetrics(await simulateArm(config, new Rng("page-seed"), cases, reminders(true)));
    const none = computeMetrics(await simulateArm(config, new Rng("page-seed"), cases, reminders(false)));
    expect(a).toEqual(b);
    expect(a.recoveredCents).toBeGreaterThan(none.recoveredCents);
  });
});
