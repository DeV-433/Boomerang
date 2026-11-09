import { describe, expect, it } from "vitest";
import {
  ACTION_MENUS,
  ACTION_TOOL,
  CASE_STATES,
  END_STATES,
  IllegalTransitionError,
  isActionFor,
  TRANSITIONS,
  transition,
  type ActionFor,
  type CaseState,
  type InvoiceAction,
} from "../src/domain";

describe("case state machine (4.1)", () => {
  const legal: [CaseState, CaseState][] = [
    ["detected", "diagnosed"],
    ["diagnosed", "proposed"],
    ["proposed", "approval"],
    ["proposed", "executed"],
    ["proposed", "awaiting"],
    ["approval", "executed"],
    ["approval", "awaiting"],
    ["executed", "awaiting"],
    ["awaiting", "diagnosed"],
  ];

  it.each(legal)("allows %s -> %s", (from, to) => {
    expect(transition(from, to)).toBe(to);
  });

  it("lets every non-final state end as recovered, stopped or escalated", () => {
    for (const from of CASE_STATES.filter((s) => !(END_STATES as readonly string[]).includes(s))) {
      for (const end of END_STATES) expect(transition(from, end)).toBe(end);
    }
  });

  it("makes end states final", () => {
    for (const from of END_STATES) {
      for (const to of CASE_STATES) expect(() => transition(from, to)).toThrow(IllegalTransitionError);
    }
  });

  it("throws on every pair not in the table, and accepts every pair in it", () => {
    let legalCount = 0;
    for (const from of CASE_STATES) {
      for (const to of CASE_STATES) {
        const allowed = TRANSITIONS[from].includes(to);
        if (allowed) {
          legalCount++;
          expect(() => transition(from, to)).not.toThrow();
        } else {
          expect(() => transition(from, to), `${from} -> ${to}`).toThrow(IllegalTransitionError);
        }
      }
    }
    expect(legalCount).toBe(legal.length + 6 * END_STATES.length);
  });

  it("rejects skipping steps, for example detected -> executed or awaiting -> proposed", () => {
    expect(() => transition("detected", "executed")).toThrow(/detected -> executed/);
    expect(() => transition("awaiting", "proposed")).toThrow(IllegalTransitionError);
    expect(() => transition("executed", "approval")).toThrow(IllegalTransitionError);
  });
});

describe("action menus (4.6)", () => {
  it("has the documented menus", () => {
    expect(ACTION_MENUS.invoice).toEqual(["send_reminder", "offer_payment_plan", "schedule_promise_check", "wait", "escalate_to_human", "stop"]);
    expect(ACTION_MENUS.subscription).toEqual([
      "send_update_payment_message",
      "wait_for_paypal_retry",
      "request_balance_capture",
      "schedule_follow_up",
      "escalate_to_human",
      "stop",
    ]);
  });

  it("checks membership at runtime", () => {
    expect(isActionFor("invoice", "send_reminder")).toBe(true);
    expect(isActionFor("invoice", "request_balance_capture")).toBe(false);
    expect(isActionFor("subscription", "issue_refund")).toBe(false);
  });

  it("rejects unknown actions in the type system", () => {
    // These lines only compile because each carries @ts-expect-error: `npm run typecheck` fails if
    // any of them stops being a type error.
    // @ts-expect-error not an action at all
    const unknown: InvoiceAction = "issue_refund";
    // @ts-expect-error a subscription action is not on the invoice menu
    const crossLane: ActionFor<"invoice"> = "request_balance_capture";
    // @ts-expect-error refunds are human-only and on no menu
    const refund: ActionFor<"subscription"> = "create_refund";
    expect([unknown, crossLane, refund]).toHaveLength(3);
  });

  it("maps every action to a PayPal tool or to nothing, never to a refund or cancellation", () => {
    for (const action of [...ACTION_MENUS.invoice, ...ACTION_MENUS.subscription]) {
      expect(ACTION_TOOL[action] ?? "none").not.toMatch(/refund|cancel_sent|cancel_subscription|delete|accept_dispute/);
    }
  });
});
