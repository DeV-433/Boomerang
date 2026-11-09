import { describe, expect, it } from "vitest";
import { loadSimConfig } from "../src/config";
import { respond, responseProbabilities } from "../src/responder";
import { Rng } from "../src/rng";
import type { ContactKind, CustomerType, Outcome } from "../src/types";

const config = loadSimConfig();

/** Empirical outcome shares over many independent first contacts. */
function shares(type: CustomerType, contact: ContactKind, prior = 0, n = 6000): Record<Outcome, number> {
  const rng = new Rng("responder-test");
  const counts: Record<Outcome, number> = { pay: 0, promise: 0, ignore: 0, dispute: 0, opt_out: 0 };
  for (let i = 0; i < n; i++) counts[respond(config, rng, type, contact, prior, [type, contact, i]).outcome]++;
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / n])) as Record<Outcome, number>;
}

describe("simulator responder (3.6)", () => {
  it.each([
    ["would_pay_after_nudge", "targeted_reminder"],
    ["needs_card_update", "update_payment_message"],
    ["needs_card_update", "generic_reminder"],
    ["promises_then_pays", "payment_plan_offer"],
    ["slow_payer", "generic_reminder"],
    ["disputer", "firm_reminder"],
    ["opts_out", "generic_reminder"],
  ] as [CustomerType, ContactKind][])("%s reacts to %s as configured", (type, contact) => {
    const expected = responseProbabilities(config, type, contact, 0);
    const observed = shares(type, contact);
    for (const outcome of Object.keys(expected) as Outcome[]) {
      expect(observed[outcome], outcome).toBeCloseTo(expected[outcome], 1);
    }
  });

  it("rewards a fitting intervention: card-update message beats a generic reminder for a card problem", () => {
    expect(shares("needs_card_update", "update_payment_message").pay).toBeGreaterThan(
      shares("needs_card_update", "generic_reminder").pay * 4,
    );
  });

  it("disputers dispute and opt-outers opt out", () => {
    expect(shares("disputer", "firm_reminder").dispute).toBeGreaterThan(0.4);
    expect(shares("opts_out", "generic_reminder").opt_out).toBeGreaterThan(0.3);
  });

  it("fatigue lowers payment and raises opt-out with each prior contact", () => {
    const fresh = responseProbabilities(config, "would_pay_after_nudge", "targeted_reminder", 0);
    const tired = responseProbabilities(config, "would_pay_after_nudge", "targeted_reminder", 5);
    expect(tired.pay).toBeLessThan(fresh.pay);
    expect(tired.opt_out).toBeGreaterThan(fresh.opt_out);
  });

  it("answers the same contact the same way every time", () => {
    const rng = new Rng("x");
    const a = respond(config, rng, "promises_then_pays", "payment_plan_offer", 1, ["case-3", "contact", 4, 0]);
    const b = respond(config, rng, "promises_then_pays", "payment_plan_offer", 1, ["case-3", "contact", 4, 0]);
    expect(a).toEqual(b);
  });

  it("returns a promise date and a hidden kept flag for promises", () => {
    const rng = new Rng("p");
    for (let i = 0; i < 200; i++) {
      const r = respond(config, rng, "promises_then_pays", "payment_plan_offer", 0, ["p", i]);
      if (r.outcome === "promise") {
        expect(r.promiseInDays).toBeGreaterThanOrEqual(config.promise.inDays.min);
        expect(typeof r.promiseKept).toBe("boolean");
        return;
      }
    }
    throw new Error("no promise in 200 draws");
  });
});
