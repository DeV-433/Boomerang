import type { Tone } from "@boomerang/core";
import type { CaseSnapshot } from "./diagnose";

export type TemplateId = "reminder" | "payment_plan" | "promise_follow_up" | "update_payment_method";

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

/** Where the customer pays. Invoices use PayPal's own payer page; the signed self-serve page arrives in 7C. */
export function paymentLink(s: Pick<CaseSnapshot, "lane" | "paypalRef">): string {
  return s.lane === "invoice"
    ? `https://www.sandbox.paypal.com/invoice/p/#${s.paypalRef}`
    : `https://www.sandbox.paypal.com/myaccount/autopay/`;
}

export const OPT_OUT_LINE = "Reply STOP and we will not contact you about this again.";

const OPENERS: Record<Tone, string> = {
  friendly: "Just a friendly reminder:",
  neutral: "Following up on our earlier message:",
  firm: "This is our final reminder before we hand this to our accounts team:",
};

/**
 * Approved templates (section 6). Every message states the amount, the reference, a payment link
 * and a way to opt out, and nothing else that is not in the case data. Step 5.6 adds tone variants
 * per stage and the model's personalisation inside these slots; 5.8 lints the result.
 */
export function renderMessage(template: TemplateId, s: CaseSnapshot, tone: Tone): { tone: Tone; template: string; subject: string; body: string } {
  const amount = money(s.amountCents, s.currency);
  const greeting = s.customerName ? `Hi ${s.customerName},` : "Hello,";
  const ref = s.lane === "invoice" ? `invoice ${s.paypalRef}` : `subscription ${s.paypalRef}`;
  const link = paymentLink(s);
  const lines: Record<TemplateId, string> = {
    reminder: `${OPENERS[tone]} ${ref} for ${amount} is past due. You can pay it here: ${link}`,
    payment_plan: `${OPENERS[tone]} ${ref} for ${amount} is past due. If paying it at once is difficult, reply and we can split it into smaller payments. Pay here: ${link}`,
    promise_follow_up: `You told us you would pay ${ref} for ${amount} by ${s.promiseDate}. We have not received it yet. You can pay here: ${link}`,
    update_payment_method: `We could not collect ${amount} for ${ref} because your payment method was declined. Please update it here: ${link}`,
  };
  const subjects: Record<TemplateId, string> = {
    reminder: `Reminder: ${ref} for ${amount}`,
    payment_plan: `Options for ${ref}`,
    promise_follow_up: `Following up on your payment for ${ref}`,
    update_payment_method: `Action needed: update your payment method`,
  };
  return { tone, template, subject: subjects[template], body: `${greeting}\n\n${lines[template]}\n\n${OPT_OUT_LINE}` };
}
