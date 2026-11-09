import type { Tone } from "./domain";

/**
 * Steps 5.6 and 5.8: approved message templates and the deterministic message lint.
 *
 * Every template carries the four required facts as fixed text: the amount, the reference, a
 * payment link and the opt-out line. The model may only fill one optional slot, `personalNote`
 * (one or two sentences), and the lint checks the finished message either way. The lint is plain
 * code, so it cannot be argued with.
 */

export const TEMPLATE_IDS = ["reminder", "payment_plan", "promise_follow_up", "update_payment_method"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const OPT_OUT_LINE = "Reply STOP and we will not contact you about this again.";

export interface MessageFacts {
  customerName: string | null;
  /** Already formatted, for example "$1,250.00". */
  amount: string;
  /** "invoice INV2-..." or "subscription I-...". */
  reference: string;
  link: string;
  /** yyyy-MM-dd, only for promise follow-ups. */
  promiseDate?: string | null;
}

export interface RenderedMessage {
  tone: Tone;
  template: TemplateId;
  subject: string;
  body: string;
  /** The model-written sentence, if any, kept separately for the audit trail and the lint. */
  personalNote?: string;
}

/** Opening line per stage (section 6: tone is set by the escalation stage, not by the model). */
const OPENERS: Record<Tone, string> = {
  friendly: "Just a friendly reminder:",
  neutral: "Following up on our earlier message:",
  firm: "This is our final reminder before we hand this to our accounts team:",
};

const CORE_LINES: Record<TemplateId, (f: MessageFacts, tone: Tone) => string> = {
  reminder: (f, tone) => `${OPENERS[tone]} ${f.reference} for ${f.amount} is past due. You can pay it here: ${f.link}`,
  payment_plan: (f, tone) =>
    `${OPENERS[tone]} ${f.reference} for ${f.amount} is past due. If paying it at once is difficult, reply and we can split it into smaller payments. Pay here: ${f.link}`,
  promise_follow_up: (f) => `You told us you would pay ${f.reference} for ${f.amount} by ${f.promiseDate}. We have not received it yet. You can pay here: ${f.link}`,
  update_payment_method: (f, tone) =>
    `${tone === "friendly" ? "" : `${OPENERS[tone]} `}We could not collect ${f.amount} for ${f.reference} because your payment method was declined. Please update it here: ${f.link}`,
};

const SUBJECTS: Record<TemplateId, (f: MessageFacts) => string> = {
  reminder: (f) => `Reminder: ${f.reference} for ${f.amount}`,
  payment_plan: (f) => `Options for ${f.reference}`,
  promise_follow_up: (f) => `Following up on your payment for ${f.reference}`,
  update_payment_method: () => "Action needed: update your payment method",
};

export function renderTemplate(template: TemplateId, facts: MessageFacts, tone: Tone, personalNote?: string): RenderedMessage {
  const greeting = facts.customerName ? `Hi ${facts.customerName},` : "Hello,";
  const note = personalNote?.trim();
  const body = [greeting, CORE_LINES[template](facts, tone), ...(note ? [note] : []), OPT_OUT_LINE].join("\n\n");
  return { tone, template, subject: SUBJECTS[template](facts), body, ...(note ? { personalNote: note } : {}) };
}

// 5.8: message lint ------------------------------------------------------------------------------------

export interface LintResult {
  ok: boolean;
  issues: string[];
}

/** Language a recovery message must never use (threats, invented consequences, pressure). */
const FORBIDDEN: [RegExp, string][] = [
  [/\b(legal action|lawsuit|sue|suing|court|attorney|lawyer|solicitor)\b/i, "threatens legal action"],
  [/\b(collection agenc(y|ies)|debt collector|collections?)\b/i, "threatens a collection agency"],
  [/\b(police|arrest|criminal|prosecut)/i, "threatens criminal consequences"],
  [/\b(credit (score|report|rating|bureau))\b/i, "threatens the customer's credit"],
  [/\b(garnish|seize|repossess)/i, "threatens seizure"],
  [/\b(late fee|penalty|surcharge|interest (charge|rate)|additional fee|extra fee)\b/i, "mentions a fee not in the case data"],
  [/\b(suspend|terminate|close|freeze)\s+(your\s+)?(account|access)\b/i, "threatens account action not in the case data"],
  [/\b(last chance|act now|immediately or|failure to pay will)\b/i, "uses pressure or ultimatum language"],
  [/\b(stupid|idiot|irresponsible|shame|disgrace)/i, "insults the customer"],
];

/** Deadline phrasing; a deadline is only allowed if it is the customer's own promised date. */
const DEADLINE = /\b(within \d+\s*(hours?|days?|business days?)|by (end of|close of|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|cob)|deadline|due by|no later than|before (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;

const MONEY = /(?:[$€£₹]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|INR|dollars?)\b)/gi;
const DATE = /\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/gi;
const URL = /https?:\/\/[^\s)]+/gi;
const PERCENT = /\b\d+(?:\.\d+)?\s?%/;

const normalizeMoney = (s: string) => s.replace(/[^\d.]/g, "").replace(/\.0+$/, "").replace(/^0+(?=\d)/, "");

/**
 * Rejects drafts that miss a required fact, invent one (another amount, link, percentage or date),
 * set a deadline the customer did not give, or threaten. Applied to every outgoing message.
 */
export function lintMessage(body: string, facts: MessageFacts): LintResult {
  const issues: string[] = [];
  if (!body.includes(facts.amount)) issues.push("missing the amount");
  if (!body.includes(facts.reference)) issues.push("missing the reference");
  if (!body.includes(facts.link)) issues.push("missing the payment link");
  if (!body.includes(OPT_OUT_LINE)) issues.push("missing the opt-out line");

  const allowedMoney = normalizeMoney(facts.amount);
  for (const m of body.match(MONEY) ?? []) {
    if (normalizeMoney(m) !== allowedMoney) issues.push(`invents an amount: "${m.trim()}"`);
  }
  for (const u of body.match(URL) ?? []) {
    if (u.replace(/[.,]$/, "") !== facts.link) issues.push(`contains a link that is not the payment link: ${u}`);
  }
  if (PERCENT.test(body)) issues.push("mentions a percentage (discount, interest or fee) not in the case data");
  for (const d of body.match(DATE) ?? []) {
    if (!facts.promiseDate || !sameDay(d, facts.promiseDate)) issues.push(`mentions a date that is not the customer's promised date: "${d}"`);
  }
  if (DEADLINE.test(body)) issues.push("sets a deadline that is not in the case data");
  for (const [re, why] of FORBIDDEN) if (re.test(body)) issues.push(why);
  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}

function sameDay(mention: string, iso: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(mention)) return mention === iso;
  const parsed = new Date(`${mention.replace(/(st|nd|rd|th)\b/, "")} ${iso.slice(0, 4)} 12:00 UTC`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
