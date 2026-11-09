export const CUSTOMER_TYPES = [
  "would_pay_after_nudge",
  "needs_card_update",
  "promises_then_pays",
  "slow_payer",
  "disputer",
  "opts_out",
] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export type Lane = "invoice" | "subscription";

/** Every kind of contact a customer can receive, from Boomerang, the baseline or PayPal itself. */
export const CONTACT_KINDS = [
  "generic_reminder", // fixed-schedule reminder (PayPal auto-reminder or the merchant's dunning email)
  "targeted_reminder",
  "firm_reminder",
  "payment_plan_offer",
  "promise_check",
  "update_payment_message",
  "paypal_failure_notice", // PayPal's own email when a subscription payment fails (both arms get it)
] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export type Outcome = "pay" | "promise" | "ignore" | "dispute" | "opt_out";

/** The hidden truth about one case. Only the simulator may read it. */
export interface SimProfile {
  batchIndex: number;
  lane: Lane;
  customerType: CustomerType;
  failureKind: "soft" | "hard" | null;
}
