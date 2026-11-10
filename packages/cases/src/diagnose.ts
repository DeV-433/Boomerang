import type { Cause, Lane } from "@boomerang/core";

/**
 * Everything the diagnosis, proposer and gate may know about a case. Built from stored events and
 * PayPal reads only: never raw customer text and never the simulator's hidden profile.
 */
export interface CaseSnapshot {
  id: string;
  lane: Lane;
  amountCents: number;
  currency: string;
  paypalRef: string;
  /** Customer-facing messages already sent; also the escalation stage. */
  contacts: number;
  lastContactAt: Date | null;
  openedAt: Date;
  paypalStatus: string | null;
  /** Invoices: yyyy-MM-dd. */
  dueDate: string | null;
  /** Subscriptions. */
  failedPayments: number;
  lastFailureReason: string | null;
  /** Subscriptions (8.5): the customer says they fixed their payment method and wants a retry. */
  paymentUpdatedAt?: Date | null;
  /** yyyy-MM-dd the customer promised to pay by. */
  promiseDate: string | null;
  disputed: boolean;
  optedOut: boolean;
  customerName: string | null;
  customerTimezone: string | null;
  customerContactsLast7Days: number;
}

export interface Diagnosis {
  cause: Cause;
  /** Which rule produced the label, for the audit trail. */
  rule: string;
  /** The rules decide every case here; the model is consulted only for ambiguity (Phase 5). */
  method: "rules";
}

/** PayPal statuses meaning the money is no longer at risk. */
export const PAID_STATUSES = ["PAID", "MARKED_AS_PAID"];
export const CLOSED_UNPAID_STATUSES = ["CANCELLED", "REFUNDED", "MARKED_AS_REFUNDED", "PARTIALLY_REFUNDED"];

/**
 * Failure reasons where retrying cannot help: the payment method itself is the problem.
 * Codes from PayPal's subscription failed-payment records; confirm against live data (section 8).
 */
export const HARD_FAILURE_REASONS = [
  "PAYER_CANNOT_PAY",
  "PAYMENT_DENIED",
  "PAYER_ACCOUNT_RESTRICTED",
  "PAYER_ACCOUNT_LOCKED_OR_CLOSED",
];

/** PayPal's default payment_failure_threshold; at this count the subscription is suspended. */
export const FAILURE_THRESHOLD = 3;

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Step 4.5: rule-based diagnosis. Returns a cause label for every case, in priority order: stop
 * conditions first, then the lane's own causes (section 8 of the documentation).
 *
 * "Viewed but unpaid" from the documentation is not observable (PayPal's API does not report
 * invoice views), so the invoice lane uses "contacted, no reply" (overdue_unresponsive) instead.
 */
/** A PayPal reason code is UPPER_SNAKE_CASE; anything else came from somewhere it should not have. */
const reasonCode = (r: string | null) =>
  r && /^[A-Z][A-Z_]{2,48}$/.test(r) ? r : r ? "UNRECOGNISED_REASON" : null;

export function diagnose(s: CaseSnapshot, now: Date): Diagnosis {
  const d = (cause: Cause, rule: string): Diagnosis => ({ cause, rule, method: "rules" });
  const reason = reasonCode(s.lastFailureReason);
  const status = s.paypalStatus?.toUpperCase() ?? null;

  // Invoice statuses only: for a subscription, CANCELLED can still mean money owed (handled below).
  if (
    s.lane === "invoice" &&
    status &&
    (PAID_STATUSES.includes(status) || CLOSED_UNPAID_STATUSES.includes(status))
  ) {
    return d("resolved", `paypal status ${status}`);
  }
  if (s.disputed) return d("dispute", "dispute recorded on the case");
  if (s.optedOut) return d("opted_out", "customer opted out");

  if (s.lane === "subscription") {
    if (status === "CANCELLED" || status === "EXPIRED") {
      return s.amountCents > 0
        ? d("cancelled_with_balance", `subscription ${status} with balance owing`)
        : d("resolved", `subscription ${status}, nothing owed`);
    }
    // 8.5: the customer fixed their payment method, so retrying the balance now can work.
    if (s.paymentUpdatedAt && s.amountCents > 0)
      return d("payment_method_updated", "customer updated their payment method and asked for a retry");
    if (status === "SUSPENDED" || s.failedPayments >= FAILURE_THRESHOLD)
      return d("threshold_reached", `suspended or ${s.failedPayments} failed payments`);
    if (reason && HARD_FAILURE_REASONS.includes(reason))
      return d("expired_funding_source", `hard failure ${reason}`);
    if (s.failedPayments >= 2) return d("expired_funding_source", "repeated failure after PayPal's retry");
    return d(
      "temporary_decline",
      `first failure${reason ? ` (${reason})` : ""}, may clear on PayPal's retry`,
    );
  }

  if (s.promiseDate) {
    return s.promiseDate >= isoDay(now)
      ? d("promise_to_pay", `promised by ${s.promiseDate}`)
      : d("broken_promise", `promise date ${s.promiseDate} passed unpaid`);
  }
  return s.contacts === 0
    ? d("overdue_no_engagement", "overdue, not yet contacted")
    : d("overdue_unresponsive", `${s.contacts} contact(s), no reply`);
}
