import { MAX_CONTACT_STAGES, toneForStage, type Action, type Cause, type Proposal } from "@boomerang/core";
import type { CaseSnapshot, Diagnosis } from "./diagnose";
import { renderMessage, type TemplateId } from "./messages";

/** Rules are certain about what the table says; the gate's confidence floor never holds them. */
export const RULES_CONFIDENCE = 0.9;

/** Above this, an unresponsive invoice gets a payment plan offer before a firm reminder. */
export const PAYMENT_PLAN_MIN_CENTS = 50_000;

const H = { day: 24, retryWindow: 6 * 24, followUp: 72 };

/**
 * Step 4.7: the rule-based proposer, a placeholder for the agent and later its fallback. Maps each
 * cause to its first action using the table in section 8 of the documentation.
 */
export function proposeByRules(s: CaseSnapshot, diagnosis: Diagnosis, now: Date): Proposal {
  const base = { caseId: s.id, cause: diagnosis.cause, confidence: RULES_CONFIDENCE, proposedBy: "rules" };
  const p = (action: Action, reason: string, nextCheckAfterHours: number, template?: TemplateId): Proposal => ({
    ...base,
    action,
    reason,
    nextCheckAfterHours,
    ...(template ? { message: renderMessage(template, s, toneForStage(s.contacts)) } : {}),
  });
  const exhausted = s.contacts >= MAX_CONTACT_STAGES;

  const byCause: Record<Cause, () => Proposal> = {
    resolved: () => p("stop", "PayPal reports the money is no longer at risk", 0),
    dispute: () => p("escalate_to_human", "a dispute is open; contact stops and a person takes over", 0),
    opted_out: () => p("stop", "the customer asked not to be contacted", 0),

    temporary_decline: () => p("wait_for_paypal_retry", "soft failure: PayPal retries in 5 days; check again after the retry window", H.retryWindow),
    expired_funding_source: () =>
      exhausted
        ? p("escalate_to_human", `${s.contacts} update requests sent with no fix`, 0)
        : p("send_update_payment_message", "hard failure: retrying cannot help until the customer updates their payment method", H.followUp, "update_payment_method"),
    threshold_reached: () =>
      s.amountCents > 0
        ? p("request_balance_capture", "subscription suspended at the failure threshold with a balance owing", H.followUp)
        : p("escalate_to_human", "subscription suspended at the failure threshold", 0),
    cancelled_with_balance: () => p("escalate_to_human", "cancelled with a balance owing: capture, settle offline or write off is a person's call", 0),

    overdue_no_engagement: () => p("send_reminder", "overdue and not yet contacted: targeted first reminder", H.followUp, "reminder"),
    overdue_unresponsive: () => {
      if (exhausted) return p("escalate_to_human", `${s.contacts} reminders sent with no reply; the agent sends nothing further`, 0);
      if (s.contacts === 1 && s.amountCents >= PAYMENT_PLAN_MIN_CENTS) {
        return p("offer_payment_plan", "no reply to the first reminder on a larger amount: offer to split it", H.followUp, "payment_plan");
      }
      return p("send_reminder", `no reply after ${s.contacts} contact(s): ${toneForStage(s.contacts)} reminder`, H.followUp, "reminder");
    },
    promise_to_pay: () => {
      const due = new Date(`${s.promiseDate}T00:00:00Z`).getTime() + 36 * 3_600_000; // the day after, midday UTC
      const hours = Math.max(1, Math.ceil((due - now.getTime()) / 3_600_000));
      return p("schedule_promise_check", `customer promised to pay by ${s.promiseDate}; check the day after`, hours);
    },
    broken_promise: () =>
      exhausted
        ? p("escalate_to_human", "promise missed and contact stages used up", 0)
        : p("send_reminder", `promise for ${s.promiseDate} was missed: follow up on it`, H.followUp, "promise_follow_up"),
  };
  return byCause[diagnosis.cause]();
}
