import { describe, expect, it } from "vitest";
import { assertAllowed, isAllowed, TOOL_WHITELIST, ToolNotAllowedError } from "../src/whitelist";

describe("tool whitelist (2.3)", () => {
  it("allows the invoice lane its tools", () => {
    expect(() => assertAllowed("invoice", "send_invoice_reminder")).not.toThrow();
    expect(() => assertAllowed("subscription", "show_subscription_details")).not.toThrow();
  });

  it.each([
    ["invoice", "delete_invoice"],
    ["invoice", "cancel_sent_invoice"],
    ["invoice", "record_refund_for_invoice"],
    ["invoice", "create_refund"],
    ["subscription", "cancel_subscription"],
    ["subscription", "update_subscription"],
    ["subscription", "accept_dispute_claim"],
    ["invoice", "pay_order"],
    ["invoice", "show_subscription_details"], // a tool from the other lane
    ["subscription", "send_invoice_reminder"],
    ["invoice", "create_invoice"], // seeder-only
  ])("throws when %s asks for %s", (profile, tool) => {
    expect(() => assertAllowed(profile, tool)).toThrow(ToolNotAllowedError);
  });

  it("refuses unknown profiles, including prototype keys", () => {
    expect(() => assertAllowed("admin", "get_invoice")).toThrow(ToolNotAllowedError);
    expect(() => assertAllowed("constructor", "get_invoice")).toThrow(ToolNotAllowedError);
    expect(() => assertAllowed("__proto__", "get_invoice")).toThrow(ToolNotAllowedError);
  });

  it("gives the decision lanes no tool that refunds, cancels, deletes or accepts a dispute", () => {
    const dangerous = /refund|cancel_sent|cancel_subscription|delete|accept_dispute|pay_order|update_subscription/;
    for (const profile of ["invoice", "subscription"] as const) {
      for (const tool of TOOL_WHITELIST[profile]) expect(tool).not.toMatch(dangerous);
    }
    expect(isAllowed("invoice", "cancel_invoice_auto_reminder")).toBe(true); // stops PayPal's reminders only
  });
});
