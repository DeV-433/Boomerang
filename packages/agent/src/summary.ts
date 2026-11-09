import { ACTION_MENUS, MAX_CONTACT_STAGES } from "@boomerang/core";
import type { CaseSnapshot, Diagnosis } from "@boomerang/cases";

/**
 * Step 5.2: the only view of a case the decision model ever gets. Structured fields only: numbers,
 * booleans, dates and closed labels. No names, emails, invoice notes, memo fields or customer
 * replies, so nothing a customer wrote can reach the decision prompt. Data minimisation also means
 * no PayPal ids: the model does not need them to choose an action.
 */
export interface CaseSummary {
  case_id: string;
  lane: "invoice" | "subscription";
  amount: number;
  currency: string;
  amount_band: "under_100" | "100_to_500" | "500_to_2000" | "over_2000";
  stage: number;
  max_stages: number;
  days_overdue: number | null;
  days_since_last_contact: number | null;
  diagnosed_cause: string;
  paypal_status: string | null;
  failed_payments: number | null;
  failure_reason: string | null;
  promise: { date: string; status: "upcoming" | "missed" } | null;
  disputed: boolean;
  opted_out: boolean;
  customer_timezone_known: boolean;
  allowed_actions: readonly string[];
}

/** PayPal reason codes the summary passes through; anything else becomes "OTHER". */
const KNOWN_REASON_CODES = [
  "PAYER_CANNOT_PAY",
  "PAYMENT_DENIED",
  "PAYER_ACCOUNT_RESTRICTED",
  "PAYER_ACCOUNT_LOCKED_OR_CLOSED",
  "INTERNAL_SERVER_ERROR",
  "SENDING_LIMIT_EXCEEDED",
  "TRANSACTION_RECEIVING_LIMIT_EXCEEDED",
  "CURRENCY_MISMATCH",
  "PAYEE_ACCOUNT_RESTRICTED",
];
const KNOWN_STATUSES = [
  "DRAFT",
  "SENT",
  "UNPAID",
  "PARTIALLY_PAID",
  "PAID",
  "MARKED_AS_PAID",
  "CANCELLED",
  "REFUNDED",
  "ACTIVE",
  "SUSPENDED",
  "EXPIRED",
  "APPROVAL_PENDING",
];

const DAY = 86_400_000;
const days = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY));

function band(cents: number): CaseSummary["amount_band"] {
  const d = cents / 100;
  return d < 100 ? "under_100" : d < 500 ? "100_to_500" : d < 2000 ? "500_to_2000" : "over_2000";
}

const closed = (value: string | null, allowed: readonly string[]) =>
  value === null ? null : allowed.includes(value) ? value : "OTHER";

export function buildCaseSummary(s: CaseSnapshot, diagnosis: Diagnosis, now: Date): CaseSummary {
  const today = now.toISOString().slice(0, 10);
  return {
    case_id: s.id,
    lane: s.lane,
    amount: Math.round(s.amountCents) / 100,
    currency: /^[A-Z]{3}$/.test(s.currency) ? s.currency : "USD",
    amount_band: band(s.amountCents),
    stage: s.contacts,
    max_stages: MAX_CONTACT_STAGES,
    days_overdue:
      s.lane === "invoice" && s.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(s.dueDate)
        ? days(new Date(`${s.dueDate}T00:00:00Z`), now)
        : null,
    days_since_last_contact: s.lastContactAt ? days(s.lastContactAt, now) : null,
    // Only the closed cause label. The rule's explanation can quote fields from outside (a PayPal
    // reason code), and a test once caught an instruction smuggled through it.
    diagnosed_cause: diagnosis.cause,
    paypal_status: closed(s.paypalStatus?.toUpperCase() ?? null, KNOWN_STATUSES),
    failed_payments: s.lane === "subscription" ? s.failedPayments : null,
    failure_reason: s.lane === "subscription" ? closed(s.lastFailureReason, KNOWN_REASON_CODES) : null,
    promise:
      s.promiseDate && /^\d{4}-\d{2}-\d{2}$/.test(s.promiseDate)
        ? { date: s.promiseDate, status: s.promiseDate >= today ? "upcoming" : "missed" }
        : null,
    disputed: s.disputed,
    opted_out: s.optedOut,
    customer_timezone_known: Boolean(s.customerTimezone),
    allowed_actions: ACTION_MENUS[s.lane],
  };
}
