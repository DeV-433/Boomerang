import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, evaluateGate, localTime, nextWindowStart, RULES, type GateInput } from "../src/gate";

const INVOICE_TOOLS = [
  "list_invoices",
  "get_invoice",
  "send_invoice_reminder",
  "cancel_invoice_auto_reminder",
  "record_payment_for_invoice",
];
const SUB_TOOLS = ["show_subscription_details", "capture_subscription_balance"];

// Tuesday 2026-11-10 15:00 UTC = 10:00 in New York, 07:00 in Los Angeles, 20:30 in Kolkata.
const TUESDAY_10AM_NY = new Date("2026-11-10T15:00:00Z");

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    lane: "invoice",
    amountCents: 50_000,
    resolved: null,
    disputed: false,
    optedOut: false,
    customerTimezone: "America/New_York",
    contactsOnCase: 0,
    customerContactsLast7Days: 0,
    lastContactAt: null,
    proposal: { action: "send_reminder", confidence: 0.9 },
    systemPaused: false,
    enabledTools: INVOICE_TOOLS,
    policy: DEFAULT_POLICY,
    now: TUESDAY_10AM_NY,
    ...overrides,
  };
}

describe("a clean proposal", () => {
  it("is allowed and every rule is recorded as checked", () => {
    const d = evaluateGate(input());
    expect(d).toMatchObject({
      verdict: "allow",
      decidedBy: 0,
      effect: { kind: "proceed" },
      policyVersion: 1,
    });
    expect(d.checks.map((c) => c.rule)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(d.checks.every((c) => c.passed)).toBe(true);
  });
});

describe("rules 1 to 3: stop conditions (4.8)", () => {
  it("1: a paid case is blocked and closed as recovered", () => {
    expect(evaluateGate(input({ resolved: "recovered" }))).toMatchObject({
      verdict: "block",
      decidedBy: 1,
      effect: { kind: "close", endState: "recovered" },
    });
  });
  it("1: a cancelled case is blocked and closed as stopped", () => {
    expect(evaluateGate(input({ resolved: "stopped" }))).toMatchObject({
      verdict: "block",
      decidedBy: 1,
      effect: { kind: "close", endState: "stopped" },
    });
  });
  it("2: an open dispute blocks and escalates to a person", () => {
    expect(evaluateGate(input({ disputed: true }))).toMatchObject({
      verdict: "block",
      decidedBy: 2,
      effect: { kind: "escalate" },
    });
  });
  it("3: an opt-out blocks and stops the case", () => {
    expect(evaluateGate(input({ optedOut: true }))).toMatchObject({
      verdict: "block",
      decidedBy: 3,
      effect: { kind: "stop" },
    });
  });
  it("stop conditions win even for non-contact actions", () => {
    expect(
      evaluateGate(input({ optedOut: true, proposal: { action: "wait", confidence: 1 } })).decidedBy,
    ).toBe(3);
  });
});

describe("rules 4 to 8 (4.9)", () => {
  it("4: the kill switch blocks everything", () => {
    expect(evaluateGate(input({ systemPaused: true }))).toMatchObject({
      verdict: "block",
      decidedBy: 4,
      effect: { kind: "pause" },
    });
  });

  it("5: an action from the other lane's menu is blocked", () => {
    expect(
      evaluateGate(input({ proposal: { action: "request_balance_capture", confidence: 1 } })),
    ).toMatchObject({ verdict: "block", decidedBy: 5 });
  });
  it("5: an action whose PayPal tool is not enabled is blocked", () => {
    expect(evaluateGate(input({ enabledTools: ["get_invoice"] }))).toMatchObject({
      verdict: "block",
      decidedBy: 5,
    });
  });
  it("5: a made-up action is blocked", () => {
    expect(
      evaluateGate(input({ proposal: { action: "issue_refund" as never, confidence: 1 } })).decidedBy,
    ).toBe(5);
  });

  it("6: the per-case cap blocks and escalates", () => {
    expect(evaluateGate(input({ contactsOnCase: 3 }))).toMatchObject({
      verdict: "block",
      decidedBy: 6,
      effect: { kind: "escalate" },
    });
  });
  it("6: the per-customer weekly cap blocks", () => {
    expect(evaluateGate(input({ customerContactsLast7Days: 3 })).decidedBy).toBe(6);
  });
  it("6: caps do not stop non-contact actions", () => {
    expect(
      evaluateGate(input({ contactsOnCase: 99, proposal: { action: "wait", confidence: 1 } })).verdict,
    ).toBe("allow");
  });

  it("7: too soon after the last contact blocks until the gap has passed", () => {
    const last = new Date(TUESDAY_10AM_NY.getTime() - 24 * 3_600_000);
    const d = evaluateGate(input({ lastContactAt: last }));
    expect(d).toMatchObject({ verdict: "block", decidedBy: 7, effect: { kind: "retry_at" } });
    expect((d.effect as { at: Date }).at).toEqual(new Date(last.getTime() + 48 * 3_600_000));
  });
  it("7: once the gap has passed, contact is allowed", () => {
    expect(
      evaluateGate(input({ lastContactAt: new Date(TUESDAY_10AM_NY.getTime() - 49 * 3_600_000) })).verdict,
    ).toBe("allow");
  });

  describe("8: contact hours across time zones", () => {
    it("allows 10:00 in New York", () => {
      expect(evaluateGate(input({ customerTimezone: "America/New_York" })).verdict).toBe("allow");
    });
    it("holds 07:00 in Los Angeles until 09:00 local", () => {
      const d = evaluateGate(input({ customerTimezone: "America/Los_Angeles" }));
      expect(d).toMatchObject({ verdict: "hold", decidedBy: 8, effect: { kind: "retry_at" } });
      expect((d.effect as { at: Date }).at.toISOString()).toBe("2026-11-10T17:00:00.000Z"); // 09:00 PST
    });
    it("holds 20:30 in Kolkata until 09:00 the next morning local", () => {
      const d = evaluateGate(input({ customerTimezone: "Asia/Kolkata" }));
      expect(d.decidedBy).toBe(8);
      expect((d.effect as { at: Date }).at.toISOString()).toBe("2026-11-11T03:30:00.000Z"); // 09:00 IST
    });
    it("holds on a Sunday until Monday", () => {
      const sunday = new Date("2026-11-15T15:00:00Z");
      const d = evaluateGate(input({ now: sunday }));
      expect(d.decidedBy).toBe(8);
      expect(localTime((d.effect as { at: Date }).at, "America/New_York")).toEqual({ hour: 9, weekday: 1 });
    });
    it("uses the merchant's zone and a narrower window when the customer's zone is unknown", () => {
      const nineThirtyNY = new Date("2026-11-10T14:30:00Z");
      expect(evaluateGate(input({ now: nineThirtyNY, customerTimezone: "America/New_York" })).verdict).toBe(
        "allow",
      ); // 9-19
      const d = evaluateGate(input({ now: nineThirtyNY, customerTimezone: null })); // 10-17 merchant fallback
      expect(d.decidedBy).toBe(8);
      expect((d.effect as { at: Date }).at.toISOString()).toBe("2026-11-10T15:00:00.000Z");
      expect(evaluateGate(input({ now: nineThirtyNY, customerTimezone: "Not/AZone" })).decidedBy).toBe(8); // invalid zone = unknown
    });
    it("finds a quarter-hour-offset window start (Nepal, UTC+5:45)", () => {
      const at = nextWindowStart(new Date("2026-11-10T00:00:00Z"), {
        timeZone: "Asia/Kathmandu",
        start: 9,
        end: 19,
        days: [0, 1, 2, 3, 4, 5, 6],
      });
      expect(at.toISOString()).toBe("2026-11-10T03:15:00.000Z");
    });
    it("handles daylight-saving changes (New York, first Sunday of November)", () => {
      const at = nextWindowStart(new Date("2026-11-01T05:30:00Z"), {
        timeZone: "America/New_York",
        start: 9,
        end: 19,
        days: [1, 2, 3, 4, 5, 6],
      });
      expect(at.toISOString()).toBe("2026-11-02T14:00:00.000Z"); // Monday 09:00 EST (UTC-5)
    });
  });
});

describe("rules 9 to 12 (4.10)", () => {
  it("9: a case above the approval limit is held for a person", () => {
    expect(evaluateGate(input({ amountCents: 250_000 }))).toMatchObject({
      verdict: "hold",
      decidedBy: 9,
      effect: { kind: "approval" },
    });
  });
  it("9: once a person approved it, the amount no longer holds it", () => {
    expect(evaluateGate(input({ amountCents: 250_000, approvedByHuman: true })).verdict).toBe("allow");
  });
  it("9: waiting is never held for approval", () => {
    expect(
      evaluateGate(input({ amountCents: 9_999_999, proposal: { action: "wait", confidence: 1 } })).verdict,
    ).toBe("allow");
  });
  it("10: low confidence is held for a person", () => {
    expect(evaluateGate(input({ proposal: { action: "send_reminder", confidence: 0.4 } }))).toMatchObject({
      verdict: "hold",
      decidedBy: 10,
    });
  });
  it("11: a failing draft is blocked for one redraft", () => {
    expect(evaluateGate(input({ messageLint: { ok: false, issues: ["missing amount"] } }))).toMatchObject({
      verdict: "block",
      decidedBy: 11,
      effect: { kind: "redraft" },
    });
  });
  it("11: a failing redraft is held for a person", () => {
    expect(
      evaluateGate(input({ messageLint: { ok: false, issues: ["threat"] }, redrafted: true })),
    ).toMatchObject({ verdict: "hold", decidedBy: 11, effect: { kind: "approval" } });
  });
  it("12: balance capture always needs approval", () => {
    const d = evaluateGate(
      input({
        lane: "subscription",
        enabledTools: SUB_TOOLS,
        amountCents: 2_900,
        proposal: { action: "request_balance_capture", confidence: 1 },
      }),
    );
    expect(d).toMatchObject({ verdict: "hold", decidedBy: 12, effect: { kind: "approval" } });
  });
  it("12: an approved capture is allowed", () => {
    const d = evaluateGate(
      input({
        lane: "subscription",
        enabledTools: SUB_TOOLS,
        proposal: { action: "request_balance_capture", confidence: 1 },
        approvedByHuman: true,
      }),
    );
    expect(d.verdict).toBe("allow");
  });
  it("escalate and stop are never held", () => {
    for (const action of ["escalate_to_human", "stop"] as const) {
      expect(
        evaluateGate(input({ amountCents: 9_999_999, proposal: { action, confidence: 0 } })).verdict,
      ).toBe("allow");
    }
  });
});

describe("rule order (4.11)", () => {
  /** Inputs that make each rule fail on its own, starting from a clean input. */
  const FAIL: Record<number, Partial<GateInput>> = {
    1: { resolved: "recovered" },
    2: { disputed: true },
    3: { optedOut: true },
    4: { systemPaused: true },
    5: { enabledTools: [] },
    6: { contactsOnCase: 5 },
    7: { lastContactAt: new Date(TUESDAY_10AM_NY.getTime() - 3_600_000) },
    8: { customerTimezone: "Asia/Kolkata" },
    9: { amountCents: 5_000_000 },
    10: { proposal: { action: "send_reminder", confidence: 0.1 } },
    11: { messageLint: { ok: false, issues: ["x"] } },
  };

  it("each failure input on its own fails exactly the intended rule", () => {
    for (const [rule, patch] of Object.entries(FAIL)) {
      expect(evaluateGate(input(patch)).decidedBy, `rule ${rule}`).toBe(Number(rule));
    }
  });

  it("the first failing rule always decides, whatever combination fails and in whatever order it is applied", () => {
    const ruleIds = Object.keys(FAIL).map(Number);
    fc.assert(
      fc.property(fc.shuffledSubarray(ruleIds, { minLength: 1 }), (subset) => {
        // Apply the failure patches in a random order; later patches never undo earlier ones.
        const patch = Object.assign({}, ...subset.map((r) => FAIL[r]));
        const decision = evaluateGate(input(patch));
        const failed = decision.checks.filter((c) => !c.passed).map((c) => c.rule);
        expect(decision.decidedBy).toBe(Math.min(...subset));
        expect(decision.decidedBy).toBe(failed[0]);
      }),
      { numRuns: 500 },
    );
  });

  it("the rule list is in documented order", () => {
    expect(RULES.map((r) => r.rule)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});
