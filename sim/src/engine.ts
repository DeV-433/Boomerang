import type { SimConfig } from "./config";
import { respond } from "./responder";
import type { Rng } from "./rng";
import type { ContactKind, Lane, Outcome, SimProfile } from "./types";

export interface SimCase {
  caseId: string;
  lane: Lane;
  amountCents: number;
  profile: SimProfile;
  /** Facts a merchant can actually see in PayPal (for example the failure reason code). */
  visible?: { reasonCode?: string | null; timezone?: string | null };
}

/** What a strategy is allowed to know: things the merchant would actually observe. Never the hidden type. */
export type Observation =
  | { day: number; kind: "reply"; outcome: Exclude<Outcome, "pay" | "ignore">; promiseDay?: number }
  | { day: number; kind: "payment_failed"; failedPayments: number }
  | { day: number; kind: "suspended" };

export interface StrategyView {
  caseId: string;
  lane: Lane;
  amountCents: number;
  day: number;
  contactsSoFar: number;
  lastContactDay: number | null;
  observations: readonly Observation[];
  visible: { reasonCode?: string | null; timezone?: string | null };
}

export interface Strategy {
  name: string;
  /** Contacts to send to this case today. Empty means wait. May be async (the agent calls a model). */
  contactsFor(view: StrategyView): ContactKind[] | Promise<ContactKind[]>;
}

export type TimelineEntry =
  | { day: number; event: "contact"; kind: ContactKind; outcome: Outcome; afterOptOut: boolean }
  | { day: number; event: "paypal_retry"; success: boolean }
  | { day: number; event: "paypal_failure_notice"; outcome: Outcome }
  | { day: number; event: "suspended" }
  | { day: number; event: "promise_due"; kept: boolean }
  | { day: number; event: "paid"; via: "contact" | "promise" | "self" | "paypal_retry" };

export type CaseOutcome = "recovered" | "disputed" | "opted_out" | "unrecovered";

export interface CaseResult {
  caseId: string;
  lane: Lane;
  amountCents: number;
  recoveredCents: number;
  recoveredDay: number | null;
  /** Messages the strategy sent (PayPal's own failure emails are not counted). */
  contacts: number;
  contactsAfterOptOut: number;
  outcome: CaseOutcome;
  timeline: TimelineEntry[];
}

/**
 * Step 3.7: simulates one case day by day on a virtual clock, against PayPal's default behaviour
 * plus whatever the strategy decides. Pure and deterministic: every random draw is keyed by the
 * case's batch index, the purpose and the day.
 */
export async function simulateCase(config: SimConfig, rng: Rng, simCase: SimCase, strategy: Strategy): Promise<CaseResult> {
  const { profile } = simCase;
  const key = `case-${profile.batchIndex}`;
  const type = profile.customerType;
  const timeline: TimelineEntry[] = [];
  const observations: Observation[] = [];
  const retry = config.paypalRetry;

  // Mutated inside closures, so kept on an object (TypeScript cannot track closure writes to locals).
  const st: {
    payDay: { day: number; via: "contact" | "promise" } | null;
    pendingPromise: { day: number; kept: boolean } | null;
  } = { payDay: null, pendingPromise: null };
  let recoveredDay: number | null = null;
  let disputed = false;
  let optedOut = false;
  let contacts = 0;
  let contactsAfterOptOut = 0;
  let lastContactDay: number | null = null;
  let customerContacts = 0; // every message the customer saw, including PayPal's, for fatigue
  let failedPayments = 1;
  let suspended = false;
  let cardFixed = false;

  const schedulePay = (day: number, via: "contact" | "promise") => {
    if (!st.payDay || day < st.payDay.day) st.payDay = { day, via };
  };

  const handleResponse = (day: number, outcome: Outcome, r: ReturnType<typeof respond>) => {
    if (outcome === "pay") {
      if (simCase.lane === "subscription") cardFixed = true;
      schedulePay(day + (r.payInDays ?? 0), "contact");
    } else if (outcome === "promise") {
      const promiseDay = day + (r.promiseInDays ?? 0);
      st.pendingPromise = { day: promiseDay, kept: Boolean(r.promiseKept) };
      observations.push({ day, kind: "reply", outcome: "promise", promiseDay });
    } else if (outcome === "dispute") {
      disputed = true;
      observations.push({ day, kind: "reply", outcome: "dispute" });
    } else if (outcome === "opt_out") {
      optedOut = true;
      observations.push({ day, kind: "reply", outcome: "opt_out" });
    }
  };

  const markPaid = (day: number, via: "contact" | "promise" | "self" | "paypal_retry") => {
    recoveredDay = day;
    timeline.push({ day, event: "paid", via });
  };

  if (simCase.lane === "subscription") observations.push({ day: 0, kind: "payment_failed", failedPayments });

  for (let day = 0; day <= config.horizonDays && recoveredDay === null; day++) {
    // 1. Money already on its way arrives.
    if (st.pendingPromise && st.pendingPromise.day === day) {
      timeline.push({ day, event: "promise_due", kept: st.pendingPromise.kept });
      if (st.pendingPromise.kept && !disputed) schedulePay(day, "promise");
      st.pendingPromise = null;
    }
    if (st.payDay && st.payDay.day <= day && !disputed) {
      markPaid(day, st.payDay.via);
      break;
    }

    // 2. PayPal's own behaviour (identical in both arms).
    if (simCase.lane === "subscription" && !suspended && day > 0 && day % retry.intervalDays === 0 && day / retry.intervalDays <= retry.maxRetriesPerCycle) {
      const p = cardFixed ? retry.afterCardUpdateSuccessProbability : profile.failureKind === "soft" ? retry.softSuccessProbability : 0;
      const success = !disputed && rng.chance(p, key, "paypal-retry", day);
      timeline.push({ day, event: "paypal_retry", success });
      if (success) {
        markPaid(day, "paypal_retry");
        break;
      }
      failedPayments++;
      observations.push({ day, kind: "payment_failed", failedPayments });
      const notice = disputed || optedOut ? { outcome: "ignore" as const } : respond(config, rng, type, "paypal_failure_notice", customerContacts, [key, "notice", day]);
      customerContacts++;
      timeline.push({ day, event: "paypal_failure_notice", outcome: notice.outcome });
      handleResponse(day, notice.outcome, notice);
      if (failedPayments >= retry.paymentFailureThreshold) {
        suspended = true;
        observations.push({ day, kind: "suspended" });
        timeline.push({ day, event: "suspended" });
      }
    }

    // 3. Some customers pay without being asked.
    if (!disputed && rng.chance(config.dailySelfPay[type], key, "self-pay", day)) {
      markPaid(day, "self");
      break;
    }

    // 4. The strategy's contacts for today.
    const sends = await strategy.contactsFor({
      caseId: simCase.caseId,
      lane: simCase.lane,
      amountCents: simCase.amountCents,
      day,
      contactsSoFar: contacts,
      lastContactDay,
      observations,
      visible: simCase.visible ?? {},
    });
    sends.forEach((kind, n) => {
      contacts++;
      lastContactDay = day;
      const afterOptOut = optedOut;
      if (afterOptOut) contactsAfterOptOut++;
      const r = disputed || optedOut ? { outcome: "ignore" as const } : respond(config, rng, type, kind, customerContacts, [key, "contact", day, n]);
      customerContacts++;
      timeline.push({ day, event: "contact", kind, outcome: r.outcome, afterOptOut });
      handleResponse(day, r.outcome, r);
    });
    // A same-day payment (pay delay 0) lands today.
    if (st.payDay && st.payDay.day <= day && !disputed) markPaid(day, st.payDay.via);
  }

  const recovered = recoveredDay !== null;
  return {
    caseId: simCase.caseId,
    lane: simCase.lane,
    amountCents: simCase.amountCents,
    recoveredCents: recovered ? simCase.amountCents : 0,
    recoveredDay,
    contacts,
    contactsAfterOptOut,
    outcome: recovered ? "recovered" : disputed ? "disputed" : optedOut ? "opted_out" : "unrecovered",
    timeline,
  };
}

/**
 * Simulates every case of an arm. Cases never affect each other, so they run concurrently (useful
 * when the strategy waits on a model); results come back in input order either way.
 */
export async function simulateArm(
  config: SimConfig,
  rng: Rng,
  cases: readonly SimCase[],
  strategy: Strategy,
  options: { concurrency?: number; onCase?: (done: number, total: number) => void } = {},
): Promise<CaseResult[]> {
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 1, cases.length)) }, async () => {
    while (next < cases.length) {
      const i = next++;
      results[i] = await simulateCase(config, rng, cases[i]!, strategy);
      options.onCase?.(++done, cases.length);
    }
  });
  await Promise.all(workers);
  return results;
}
