/**
 * Step 2.3: least privilege. Each profile lists the only PayPal operations it may perform.
 * Section 5 of the project documentation is the source for the lane lists. Tools left off on
 * purpose include delete_invoice, cancel_sent_invoice, record_refund_for_invoice, cancel_subscription,
 * update_subscription, pay_order, create_refund and accept_dispute_claim: those stay human-only.
 */

/** Operations Boomerang performs with direct REST calls because the toolkit has no tool for them. */
export const REST_OPERATIONS = [
  "capture_subscription_balance",
  // Sandbox test harness only (seeder profile): creates overdue invoices and outstanding balances,
  // which the toolkit cannot (create_invoice has no due date; sandbox will not fail payments on demand).
  "create_invoice_with_terms",
  "set_subscription_outstanding_balance",
] as const;
export type RestOperation = (typeof REST_OPERATIONS)[number];

const READ_ONLY_SHARED = ["get_order", "list_disputes", "get_dispute", "list_transactions"] as const;

export const TOOL_WHITELIST = {
  invoice: [
    "list_invoices",
    "get_invoice",
    "send_invoice_reminder",
    "cancel_invoice_auto_reminder",
    "record_payment_for_invoice",
    "generate_invoice_qr_code",
    ...READ_ONLY_SHARED,
  ],
  subscription: [
    "show_subscription_details",
    "list_subscription_plans",
    "capture_subscription_balance",
    ...READ_ONLY_SHARED,
  ],
  /**
   * Used only by the sandbox seeder and test harness (Phase 3) to create the batch. Never given to
   * the decision loop, and refused when PAYPAL_ENVIRONMENT is PRODUCTION.
   */
  seeder: [
    "create_invoice",
    "send_invoice",
    "get_invoice",
    "list_invoices",
    "record_payment_for_invoice",
    "create_product",
    "create_subscription_plan",
    "create_subscription",
    "show_subscription_details",
    "create_invoice_with_terms",
    "set_subscription_outstanding_balance",
  ],
} as const;

export type Profile = keyof typeof TOOL_WHITELIST;
export type WhitelistedTool<P extends Profile> = (typeof TOOL_WHITELIST)[P][number];
export type AnyWhitelistedTool = WhitelistedTool<Profile>;

export class ToolNotAllowedError extends Error {
  constructor(
    readonly profile: string,
    readonly tool: string,
  ) {
    super(`PayPal tool "${tool}" is not whitelisted for profile "${profile}"`);
    this.name = "ToolNotAllowedError";
  }
}

export function isAllowed(profile: Profile, tool: string): boolean {
  return (TOOL_WHITELIST[profile] as readonly string[]).includes(tool);
}

/** Throws unless `tool` is on the whitelist for `profile`. Unknown profiles are refused too. */
export function assertAllowed(profile: string, tool: string): void {
  if (!Object.hasOwn(TOOL_WHITELIST, profile) || !isAllowed(profile as Profile, tool)) {
    throw new ToolNotAllowedError(profile, tool);
  }
}

export function isRestOperation(tool: string): tool is RestOperation {
  return (REST_OPERATIONS as readonly string[]).includes(tool);
}
