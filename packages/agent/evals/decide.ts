/**
 * Live evaluation for BUILD_PLAN 5.3 (and 5.7): 20 varied cases through the real Groq decision
 * and drafting calls. Done when every decision validates. Also reports agreement with the rules,
 * draft lint results, latency and cost. Calls are recorded in model_calls under run tag "eval-decide".
 *   npx tsx packages/agent/evals/decide.ts
 */
import { diagnose, proposeByRules, type CaseSnapshot } from "@boomerang/cases";
import { createLogger, loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import { decide } from "../src/agent";
import { GroqClient, RecordingClient, UsageMeter } from "../src/model";

const NOW = new Date("2026-11-10T15:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
let n = 0;
function c(o: Partial<CaseSnapshot>): CaseSnapshot {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    lane: "invoice",
    amountCents: 30_000,
    currency: "USD",
    paypalRef: `INV2-EVAL-${String(n).padStart(4, "0")}-AAAA-BBBB`,
    contacts: 0,
    lastContactAt: null,
    openedAt: NOW,
    paypalStatus: "SENT",
    dueDate: "2026-10-28",
    failedPayments: 0,
    lastFailureReason: null,
    promiseDate: null,
    disputed: false,
    optedOut: false,
    customerName: "Sam Rivera",
    customerTimezone: "America/Chicago",
    customerContactsLast7Days: 0,
    ...o,
  };
}
const sub = (o: Partial<CaseSnapshot>) => c({ lane: "subscription", paypalRef: `I-EVAL${n}`, amountCents: 2900, paypalStatus: "ACTIVE", failedPayments: 1, dueDate: null, ...o });

const CASES: [string, CaseSnapshot][] = [
  ["invoice, small, never contacted", c({ amountCents: 4_500 })],
  ["invoice, mid, never contacted", c({ amountCents: 42_000 })],
  ["invoice, large, never contacted", c({ amountCents: 380_000 })],
  ["invoice, 1 contact, small, no reply", c({ amountCents: 8_000, contacts: 1, lastContactAt: hoursAgo(80) })],
  ["invoice, 1 contact, large, no reply", c({ amountCents: 120_000, contacts: 1, lastContactAt: hoursAgo(80) })],
  ["invoice, 2 contacts, no reply", c({ amountCents: 60_000, contacts: 2, lastContactAt: hoursAgo(75) })],
  ["invoice, 3 contacts (stages used up)", c({ contacts: 3, lastContactAt: hoursAgo(90) })],
  ["invoice, promise upcoming", c({ promiseDate: "2026-11-14", contacts: 1, lastContactAt: hoursAgo(30) })],
  ["invoice, promise missed", c({ promiseDate: "2026-11-06", contacts: 1, lastContactAt: hoursAgo(120) })],
  ["invoice, promise missed, stages used up", c({ promiseDate: "2026-11-06", contacts: 3, lastContactAt: hoursAgo(120) })],
  ["invoice, very overdue, unknown zone", c({ dueDate: "2026-08-01", customerTimezone: null })],
  ["subscription, soft failure", sub({ lastFailureReason: "INTERNAL_SERVER_ERROR" })],
  ["subscription, first failure no reason", sub({})],
  ["subscription, hard failure", sub({ lastFailureReason: "PAYER_CANNOT_PAY" })],
  ["subscription, second failure", sub({ failedPayments: 2, lastFailureReason: "INTERNAL_SERVER_ERROR" })],
  ["subscription, hard failure, 1 update request sent", sub({ lastFailureReason: "PAYMENT_DENIED", contacts: 1, lastContactAt: hoursAgo(73) })],
  ["subscription, hard failure, stages used up", sub({ lastFailureReason: "PAYMENT_DENIED", contacts: 3, lastContactAt: hoursAgo(73) })],
  ["subscription, suspended with balance", sub({ paypalStatus: "SUSPENDED", failedPayments: 3, amountCents: 8_700 })],
  ["subscription, cancelled with balance", sub({ paypalStatus: "CANCELLED", amountCents: 4_900 })],
  ["subscription, large plan, hard failure", sub({ amountCents: 29_900, lastFailureReason: "PAYER_ACCOUNT_RESTRICTED" })],
];

const config = loadConfig();
const db = createDb(requireConfig(config, "DATABASE_URL"));
const meter = new UsageMeter();
const client = new RecordingClient(new GroqClient(requireConfig(config, "GROQ_API_KEY"), { rpm: config.GROQ_RPM }), {
  db: db.db,
  runTag: "eval-decide",
  meter,
  cache: true, // a re-run replays earlier answers instead of paying for them again
});
void createLogger;

let valid = 0;
let agree = 0;
let draftsOk = 0;
let drafts = 0;
try {
  for (const [name, s] of CASES) {
    const d = diagnose(s, NOW);
    const rules = proposeByRules(s, d, NOW);
    const started = Date.now();
    const p = await decide({ client, onValidated: (req, ok) => client.markValid(req, ok) }, s, d, NOW);
    // Valid unless both attempts were rejected (which escalates the case).
    const ok = (p.meta?.rejected?.length ?? 0) < 2;
    const validFirst = (p.meta?.rejected?.length ?? 0) === 0;
    if (ok) valid++;
    if (p.action === rules.action) agree++;
    if (p.message) {
      drafts++;
      if (!p.meta?.draft?.lintIssues) draftsOk++;
    }
    console.log(
      `${validFirst ? "VALID " : ok ? "RETRY " : "FAIL  "} ${name.padEnd(48)} agent=${p.action.padEnd(28)} rules=${rules.action.padEnd(28)} conf=${p.confidence.toFixed(2)} ${String(Date.now() - started).padStart(5)}ms ${p.meta?.model}`,
    );
    if (p.meta?.draft?.personalNote) console.log(`        note: "${p.meta.draft.personalNote}"${p.meta.draft.redrafted ? " (redrafted)" : ""}`);
    if (p.meta?.modelCause) console.log(`        model cause ${p.meta.modelCause} differs from rules ${d.cause}`);
  }
  const t = meter.totals;
  console.log(`\nvalid decisions: ${valid}/${CASES.length}   same action as rules: ${agree}/${CASES.length}   drafts passing lint: ${draftsOk}/${drafts}`);
  console.log(`tokens: in ${t.all.inputTokens}, out ${t.all.outputTokens}, thinking ${t.all.thinkingTokens}; cost $${t.all.costUsd.toFixed(4)} (${t.all.calls} calls)`);
  process.exitCode = valid === CASES.length ? 0 : 1;
} finally {
  await db.close();
}
