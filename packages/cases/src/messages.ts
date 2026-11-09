import { formatMoney, OPT_OUT_LINE, renderTemplate, type MessageFacts, type RenderedMessage, type TemplateId, type Tone } from "@boomerang/core";
import type { CaseSnapshot } from "./diagnose";

export { OPT_OUT_LINE, type TemplateId };

/** Where the customer pays. Invoices use PayPal's own payer page; the signed self-serve page arrives in 7C. */
export function paymentLink(s: Pick<CaseSnapshot, "lane" | "paypalRef">): string {
  return s.lane === "invoice" ? `https://www.sandbox.paypal.com/invoice/p/#${s.paypalRef}` : `https://www.sandbox.paypal.com/myaccount/autopay/`;
}

/** The facts a message must state, taken from the case record only. */
export function messageFacts(s: CaseSnapshot): MessageFacts {
  return {
    customerName: s.customerName,
    amount: formatMoney(s.amountCents, s.currency),
    reference: s.lane === "invoice" ? `invoice ${s.paypalRef}` : `subscription ${s.paypalRef}`,
    link: paymentLink(s),
    promiseDate: s.promiseDate,
  };
}

/** Renders an approved template for a case (step 5.6); the agent adds a personal note in 5.7. */
export function renderMessage(template: TemplateId, s: CaseSnapshot, tone: Tone, personalNote?: string): RenderedMessage {
  return renderTemplate(template, messageFacts(s), tone, personalNote);
}
