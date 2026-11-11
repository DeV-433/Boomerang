import {
  formatMoney,
  payLinkExpiry,
  signPayLink,
  OPT_OUT_LINE,
  renderTemplate,
  type MessageFacts,
  type RenderedMessage,
  type TemplateId,
  type Tone,
} from "@boomerang/core";
import type { CaseSnapshot } from "./diagnose";

export { OPT_OUT_LINE, type TemplateId };

let payLinks: { secret: string; baseUrl: string } | null = null;
let paypalWeb = "https://www.sandbox.paypal.com";

/** B14: PayPal's customer-facing pages follow PAYPAL_ENVIRONMENT (the API and the worker call this at startup). */
export function configurePayPalWeb(environment: "SANDBOX" | "PRODUCTION"): void {
  paypalWeb = environment === "PRODUCTION" ? "https://www.paypal.com" : "https://www.sandbox.paypal.com";
}

/**
 * Step 7C.6: turn on signed pay-page links in messages (the API and the worker call this at startup
 * when PAY_LINK_SECRET and PUBLIC_BASE_URL are set). Off: messages link to PayPal's own pages.
 */
export function configurePayLinks(config: { secret: string; baseUrl: string } | null): void {
  payLinks = config ? { secret: config.secret, baseUrl: config.baseUrl.replace(/\/$/, "") } : null;
}

/** PayPal's own page for this case: the invoice payer page, or the subscriber's automatic-payments page. */
export function paypalPayLink(s: Pick<CaseSnapshot, "lane" | "paypalRef">): string {
  return s.lane === "invoice" ? `${paypalWeb}/invoice/p/#${s.paypalRef}` : `${paypalWeb}/myaccount/autopay/`;
}

/**
 * Where the customer pays: the signed self-serve page (pay now or promise a date) when configured,
 * otherwise PayPal's own page. The same case always gets the same link (the expiry is fixed per case),
 * so a message held for approval still passes the lint when it is approved later.
 */
export function paymentLink(s: Pick<CaseSnapshot, "id" | "lane" | "paypalRef" | "openedAt">): string {
  if (!payLinks) return paypalPayLink(s);
  return `${payLinks.baseUrl}/pay/${signPayLink(payLinks.secret, s.id, payLinkExpiry(s.openedAt))}`;
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
export function renderMessage(
  template: TemplateId,
  s: CaseSnapshot,
  tone: Tone,
  personalNote?: string,
): RenderedMessage {
  return renderTemplate(template, messageFacts(s), tone, personalNote);
}
