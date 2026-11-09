import { describe, expect, it } from "vitest";
import { lintMessage, OPT_OUT_LINE, renderTemplate, TEMPLATE_IDS, type MessageFacts } from "../src/messages";
import type { Tone } from "../src/domain";

const facts: MessageFacts = {
  customerName: "Ada Lovelace",
  amount: "$1,250.00",
  reference: "invoice INV2-AB12-CD34-EF56-GH78",
  link: "https://www.sandbox.paypal.com/invoice/p/#INV2-AB12-CD34-EF56-GH78",
  promiseDate: "2026-11-14",
};
const TONES: Tone[] = ["friendly", "neutral", "firm"];
/** A message built from the template with the given personal note (what the drafting call returns). */
const withNote = (
  note: string,
  template: (typeof TEMPLATE_IDS)[number] = "reminder",
  tone: Tone = "neutral",
) => renderTemplate(template, facts, tone, note).body;

describe("message templates (5.6)", () => {
  it.each(TEMPLATE_IDS.flatMap((t) => TONES.map((tone) => [t, tone] as const)))(
    "%s / %s renders with every required field and passes lint",
    (template, tone) => {
      const m = renderTemplate(template, facts, tone);
      for (const required of [facts.amount, facts.reference, facts.link, OPT_OUT_LINE])
        expect(m.body).toContain(required);
      expect(m.subject.length).toBeGreaterThan(5);
      expect(m.tone).toBe(tone);
      expect(lintMessage(m.body, facts)).toEqual({ ok: true, issues: [] });
    },
  );

  it("tone changes the wording by stage", () => {
    const bodies = TONES.map((tone) => renderTemplate("reminder", facts, tone).body);
    expect(new Set(bodies).size).toBe(3);
    expect(bodies[2]).toMatch(/final reminder/);
  });

  it("states the promised date in a promise follow-up", () => {
    expect(renderTemplate("promise_follow_up", facts, "neutral").body).toContain("2026-11-14");
  });

  it("greets without a name when the name is unknown", () => {
    expect(
      renderTemplate("reminder", { ...facts, customerName: null }, "friendly").body.startsWith("Hello,"),
    ).toBe(true);
  });
});

describe("message lint (5.8)", () => {
  // Fifteen drafts that must all be rejected, one failure mode each (several have more than one).
  const bad: [string, string][] = [
    ["threatens legal action", withNote("If we do not hear from you we will take legal action.")],
    ["threatens a collection agency", withNote("Unpaid balances are passed to a collection agency.")],
    ["threatens the customer's credit", withNote("This may affect your credit score.")],
    ["invents a late fee", withNote("A late fee will be added next week.")],
    ["invents a different amount", withNote("Paying $1,000.00 today settles it.")],
    ["invents a discount percentage", withNote("Pay today and get 10% off.")],
    ["sets a deadline in hours", withNote("Please pay within 48 hours.")],
    ["sets a weekday deadline", withNote("Please pay by Friday.")],
    ["invents a date", withNote("Your account will be reviewed on 2026-12-01.")],
    ["adds an unknown link", withNote("You can also pay at https://pay-now.example.com/fast")],
    ["threatens account action", withNote("Otherwise we will suspend your account.")],
    ["uses ultimatum language", withNote("This is your last chance.")],
    ["insults the customer", withNote("It is irresponsible to ignore this.")],
    ["drops the opt-out line", renderTemplate("reminder", facts, "friendly").body.replace(OPT_OUT_LINE, "")],
    ["drops the amount and link", `Hi Ada,\n\nPlease pay ${facts.reference} soon.\n\n${OPT_OUT_LINE}`],
  ];

  // Ten drafts that must all pass: realistic, warm, factual personal notes inside the template.
  const good: string[] = [
    withNote("We know things get busy, so we wanted to make this easy."),
    withNote("If you have already paid, thank you, and please ignore this message."),
    withNote("If anything about this invoice looks wrong, just reply and we will look into it."),
    withNote("Thanks for being a customer. Let us know if you need a copy of the invoice."),
    withNote(
      "You told us you would pay by 2026-11-14, and we appreciate you letting us know.",
      "promise_follow_up",
    ),
    withNote("We are happy to talk through a schedule that works for you.", "payment_plan"),
    withNote("Updating your card takes about a minute.", "update_payment_method", "friendly"),
    withNote(
      "We have reached out a couple of times and want to make sure this reached you.",
      "reminder",
      "firm",
    ),
    withNote("If paying in parts would help, reply with what works for you.", "payment_plan", "firm"),
    renderTemplate("reminder", facts, "friendly").body,
  ];

  it.each(bad)("rejects a draft that %s", (_why, body) => {
    const result = lintMessage(body, facts);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("rejects all 15 bad drafts and passes all 10 good ones", () => {
    expect(bad.filter(([, body]) => lintMessage(body, facts).ok)).toEqual([]);
    expect(good.map((body) => lintMessage(body, facts)).filter((r) => !r.ok)).toEqual([]);
    expect([bad.length, good.length]).toEqual([15, 10]);
  });

  it("explains each rejection", () => {
    expect(
      lintMessage(withNote("Pay $1,000.00 within 48 hours or face legal action."), facts).issues,
    ).toEqual(
      expect.arrayContaining([
        'invents an amount: "$1,000.00"',
        "sets a deadline that is not in the case data",
        "threatens legal action",
      ]),
    );
  });

  it("accepts the promised date written as a month and day", () => {
    expect(
      lintMessage(withNote("Thanks for planning to pay by Nov 14.", "promise_follow_up"), facts).ok,
    ).toBe(true);
    expect(
      lintMessage(withNote("Thanks for planning to pay by Nov 20.", "promise_follow_up"), facts).ok,
    ).toBe(false);
  });
});
