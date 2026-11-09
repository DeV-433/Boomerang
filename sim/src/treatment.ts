import {
  diagnose,
  enabledTools,
  messageFacts,
  proposeByRules,
  type CaseSnapshot,
  type Proposer,
} from "@boomerang/cases";
import { isContactAction, lintMessage, type Action, type Proposal } from "@boomerang/core";
import { DEFAULT_POLICY, evaluateGate, type Policy } from "@boomerang/policy";
import type { Strategy, StrategyView } from "./engine";
import type { ContactKind } from "./types";

const H = 3_600_000;
const DAY = 24 * H;

/** Day 0 of a simulated run: a Monday, 10:00 in New York, so day numbers map to real weekdays. */
export const SIM_EPOCH = new Date("2026-11-09T15:00:00Z");
/** Simulated day d covers [SIM_EPOCH + d days, SIM_EPOCH + d + 1 days). */
const dayStart = (day: number) => new Date(SIM_EPOCH.getTime() + day * DAY);
const isoDay = (day: number) => dayStart(day).toISOString().slice(0, 10);

/** Which simulated contact a gated action becomes. Tone is set by stage, as in the live templates. */
export function contactKindFor(proposal: Proposal): ContactKind | null {
  switch (proposal.action) {
    case "send_reminder":
      if (proposal.message?.template === "promise_follow_up") return "promise_check";
      return proposal.message?.tone === "firm" ? "firm_reminder" : "targeted_reminder";
    case "offer_payment_plan":
      return "payment_plan_offer";
    case "send_update_payment_message":
      return "update_payment_message";
    default:
      return null;
  }
}

interface CaseState {
  /** Exact time of the next check, so a hold "until 09:00 in Kolkata" lands inside the right day. */
  nextCheckAt: Date;
  ended: "escalated" | "stopped" | null;
  pendingApproval: { day: number } | null;
  seenObservations: number;
  contactTimes: Date[];
}

export interface TreatmentStats {
  escalated: number;
  stopped: number;
  heldForApproval: number;
  gateBlocks: Record<number, number>;
}

/**
 * Step 4.16: the treatment arm, run through the same diagnosis, rule-based proposer and policy gate
 * the live loop uses. The simulator stands in for PayPal and the customers; persistence is skipped.
 *
 * It only sees what a merchant would: replies, failure notices and PayPal's reason code, never the
 * hidden customer type. Two documented simplifications:
 * - a hold for approval is approved by the operator the next day;
 * - an approved balance capture is handed to a person (the engine does not model capture success).
 */
export function rulesStrategy(policy: Policy = { ...DEFAULT_POLICY, mode: "live" }) {
  return loopStrategy({ name: "boomerang-rules", proposer: proposeByRules, policy });
}

/**
 * The live loop's decision path for any proposer: the rules (4.16) or the agent with rules as
 * fallback (5.10). Same diagnosis, same gate, same lint; only the proposal differs.
 */
export function loopStrategy(options: {
  name: string;
  proposer: Proposer;
  policy?: Policy;
  /** 7C.7: the loop's messages carry the self-serve pay page (needs `payPage` in the simulator config). */
  payPage?: boolean;
}): Strategy & {
  stats: TreatmentStats;
  decide(
    view: StrategyView,
    st: CaseState,
    now: Date,
  ): Promise<{ contacts: ContactKind[]; recheckAt?: Date }>;
} {
  const policy = options.policy ?? { ...DEFAULT_POLICY, mode: "live" as const };
  const states = new Map<string, CaseState>();
  const stats: TreatmentStats = { escalated: 0, stopped: 0, heldForApproval: 0, gateBlocks: {} };

  return {
    name: options.name,
    carriesPayPage: options.payPage ?? false,
    stats,
    async contactsFor(view: StrategyView): Promise<ContactKind[]> {
      let st = states.get(view.caseId);
      if (!st) {
        st = {
          nextCheckAt: SIM_EPOCH,
          ended: null,
          pendingApproval: null,
          seenObservations: 0,
          contactTimes: [],
        };
        states.set(view.caseId, st);
      }
      if (st.ended) return [];
      const today = dayStart(view.day);
      // A new reply or failure brings the check forward to today (the live loop does this via events).
      if (view.observations.length > st.seenObservations) {
        if (view.day > 0 && st.nextCheckAt > today) st.nextCheckAt = today;
        st.seenObservations = view.observations.length;
      }
      if (st.nextCheckAt >= dayStart(view.day + 1)) return [];

      let now = st.nextCheckAt > today ? st.nextCheckAt : today;
      // The engine asks once per simulated day, but a hold can expire later the same day (09:00 in
      // Kolkata is inside the day that starts 10:00 in New York): re-check at that moment.
      for (let pass = 0; pass < 4; pass++) {
        const result = await this.decide(view, st, now);
        if (result.recheckAt && result.recheckAt < dayStart(view.day + 1)) {
          now = result.recheckAt;
          continue;
        }
        return result.contacts;
      }
      return [];
    },
    async decide(
      view: StrategyView,
      st: CaseState,
      now: Date,
    ): Promise<{ contacts: ContactKind[]; recheckAt?: Date }> {
      const snapshot = toSnapshot(view, now, st.contactTimes);
      const diagnosis = diagnose(snapshot, now);
      const proposal = await options.proposer(snapshot, diagnosis, now);
      const approved = st.pendingApproval !== null && view.day >= st.pendingApproval.day;
      const decision = evaluateGate({
        lane: view.lane,
        amountCents: view.amountCents,
        resolved: null,
        disputed: snapshot.disputed,
        optedOut: snapshot.optedOut,
        customerTimezone: snapshot.customerTimezone,
        contactsOnCase: view.contactsSoFar,
        customerContactsLast7Days: snapshot.customerContactsLast7Days,
        lastContactAt: snapshot.lastContactAt,
        proposal,
        messageLint: proposal.message
          ? lintMessage(proposal.message.body, messageFacts(snapshot))
          : undefined,
        redrafted: proposal.meta?.draft?.redrafted ?? false,
        approvedByHuman: approved,
        systemPaused: false,
        enabledTools: enabledTools(view.lane),
        policy,
        now,
      });
      if (decision.verdict !== "allow")
        stats.gateBlocks[decision.decidedBy] = (stats.gateBlocks[decision.decidedBy] ?? 0) + 1;

      const effect = decision.effect;
      const end = (how: "escalated" | "stopped") => {
        st.ended = how;
        stats[how]++;
        return { contacts: [] };
      };
      switch (effect.kind) {
        case "escalate":
          return end("escalated");
        case "stop":
        case "close":
          return end("stopped");
        case "retry_at":
        case "pause":
          st.nextCheckAt =
            effect.kind === "retry_at" && effect.at > now ? effect.at : new Date(now.getTime() + H);
          return { contacts: [], recheckAt: st.nextCheckAt };
        case "approval":
        case "redraft":
          stats.heldForApproval++;
          st.pendingApproval = { day: view.day + 1 };
          st.nextCheckAt = dayStart(view.day + 1);
          return { contacts: [] };
        case "proceed": {
          st.pendingApproval = null;
          const action = proposal.action as Action;
          if (action === "escalate_to_human" || action === "request_balance_capture") return end("escalated");
          if (action === "stop") return end("stopped");
          st.nextCheckAt = new Date(now.getTime() + Math.max(1, proposal.nextCheckAfterHours) * H);
          if (!isContactAction(action)) return { contacts: [] };
          const kind = contactKindFor(proposal);
          if (kind) st.contactTimes.push(now);
          return { contacts: kind ? [kind] : [] };
        }
      }
    },
  };
}

/** What the live loop would know about this case, rebuilt from the simulator's observations. */
function toSnapshot(view: StrategyView, now: Date, contactTimes: Date[]): CaseSnapshot {
  const replies = view.observations.filter((o) => o.kind === "reply");
  const promise = [...replies].reverse().find((o) => o.outcome === "promise");
  const failures = view.observations.filter((o) => o.kind === "payment_failed");
  const lastFailure = failures[failures.length - 1];
  return {
    id: view.caseId,
    lane: view.lane,
    amountCents: view.amountCents,
    currency: "USD",
    paypalRef: view.lane === "invoice" ? "INV2-SIM0-SIM0-SIM0-SIM0" : "I-SIMULATED",
    contacts: view.contactsSoFar,
    lastContactAt: contactTimes.length ? contactTimes[contactTimes.length - 1]! : null,
    openedAt: SIM_EPOCH,
    paypalStatus:
      view.lane === "invoice"
        ? "SENT"
        : view.observations.some((o) => o.kind === "suspended")
          ? "SUSPENDED"
          : "ACTIVE",
    dueDate: null,
    failedPayments: lastFailure && lastFailure.kind === "payment_failed" ? lastFailure.failedPayments : 0,
    lastFailureReason: view.visible.reasonCode ?? null,
    promiseDate:
      promise && promise.kind === "reply" && promise.promiseDay !== undefined
        ? isoDay(promise.promiseDay)
        : null,
    disputed: replies.some((o) => o.outcome === "dispute"),
    optedOut: replies.some((o) => o.outcome === "opt_out"),
    customerName: null,
    customerTimezone: view.visible.timezone ?? null,
    // One case per customer in a batch, so the customer's weekly count is this case's.
    customerContactsLast7Days: contactTimes.filter((t) => now.getTime() - t.getTime() < 7 * DAY).length,
  };
}
