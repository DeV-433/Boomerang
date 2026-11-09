import {
  ACTION_TOOL,
  isActionFor,
  isContactAction,
  isSensitiveAction,
  type Action,
  type Lane,
  type Proposal,
} from "@boomerang/core";

/**
 * Step 4.8 to 4.11: the policy gate. A pure function of the case, the proposal, the merchant's
 * policy and the current time. No model call, no PayPal call, no database: it cannot be talked out
 * of a rule, and every rule is unit-tested. The model never sees this code or the policy.
 */

export interface Policy {
  version: number;
  mode: "dry_run" | "live";
  caps: {
    /** Contacts per case before the case goes to a person. */
    perCase: number;
    /** Contacts per customer in any rolling 7 days, across all their cases. */
    perCustomerPerWeek: number;
  };
  hours: {
    /** Allowed local contact window, in whole hours [start, end). */
    start: number;
    end: number;
    /** Days of the week contact is allowed, 0 = Sunday. */
    days: number[];
    /** Used when the customer's time zone is unknown, with the narrower window below. */
    merchantTimezone: string;
    unknownTimezoneStart: number;
    unknownTimezoneEnd: number;
  };
  thresholds: {
    /** Cases worth more than this (cents) need a person's approval before contact. */
    approvalAmountCents: number;
    /** Proposals below this confidence need a person's approval. */
    confidenceFloor: number;
    /** Minimum hours between two contacts on the same case. */
    minGapHours: number;
  };
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  mode: "dry_run",
  caps: { perCase: 3, perCustomerPerWeek: 3 },
  hours: {
    start: 9,
    end: 19,
    days: [1, 2, 3, 4, 5, 6],
    merchantTimezone: "America/New_York",
    unknownTimezoneStart: 10,
    unknownTimezoneEnd: 17,
  },
  thresholds: { approvalAmountCents: 200_000, confidenceFloor: 0.6, minGapHours: 48 },
};

export interface GateInput {
  lane: Lane;
  amountCents: number;
  /** Case facts the gate checks. Computed from stored events, never from model output. */
  /** Set when the case no longer needs recovery: paid ("recovered") or cancelled/refunded ("stopped"). */
  resolved: "recovered" | "stopped" | null;
  disputed: boolean;
  optedOut: boolean;
  customerTimezone: string | null;
  contactsOnCase: number;
  customerContactsLast7Days: number;
  lastContactAt: Date | null;
  proposal: Pick<Proposal, "action" | "confidence" | "message">;
  /** Result of the message lint (5.8). Absent when the action carries no message. */
  messageLint?: { ok: boolean; issues: string[] };
  /** True when this proposal is already the one redraft rule 11 allows. */
  redrafted?: boolean;
  /** True when a person has already approved this exact action (skips the approval holds 9, 10, 12). */
  approvedByHuman?: boolean;
  systemPaused: boolean;
  /** PayPal operations enabled for this lane (from packages/paypal's whitelist, passed in). */
  enabledTools: readonly string[];
  policy: Policy;
  now: Date;
}

export type Verdict = "allow" | "hold" | "block";

/** What the loop should do with the case as a result. */
export type Effect =
  | { kind: "proceed" }
  | { kind: "close"; endState: "recovered" | "stopped" }
  | { kind: "escalate" }
  | { kind: "stop" }
  | { kind: "pause" }
  | { kind: "retry_at"; at: Date }
  | { kind: "approval" }
  | { kind: "redraft" };

export interface RuleResult {
  rule: number;
  name: string;
  passed: boolean;
  detail?: string;
}

export interface GateDecision {
  verdict: Verdict;
  /** The rule that decided; 0 when every rule passed. */
  decidedBy: number;
  effect: Effect;
  reasons: string[];
  /** Every rule and whether it passed, for the audit entry. */
  checks: RuleResult[];
  policyVersion: number;
}

interface RuleOutcome {
  verdict: Exclude<Verdict, "allow">;
  effect: Effect;
  reason: string;
}

interface Rule {
  rule: number;
  name: string;
  /** Returns null when the rule passes. */
  check(input: GateInput): RuleOutcome | null;
}

const HOUR = 3_600_000;

/** Local hour (0-23) and weekday (0 = Sunday) of `at` in `timeZone`. */
export function localTime(at: Date, timeZone: string): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")?.value ?? "Sun");
  return { hour, weekday };
}

/** The contact window that applies: the customer's, or the narrower merchant fallback when unknown. */
export function contactWindow(input: Pick<GateInput, "customerTimezone" | "policy">): { timeZone: string; start: number; end: number; days: number[] } {
  const h = input.policy.hours;
  const known = input.customerTimezone && isValidTimeZone(input.customerTimezone);
  return known
    ? { timeZone: input.customerTimezone!, start: h.start, end: h.end, days: h.days }
    : { timeZone: h.merchantTimezone, start: h.unknownTimezoneStart, end: h.unknownTimezoneEnd, days: h.days };
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const STEP = 15 * 60_000;

/**
 * First moment at or after `from` that is inside the window. Steps in 15 minutes, because some
 * zones are offset from UTC by half or quarter hours (India +5:30, Nepal +5:45).
 */
export function nextWindowStart(from: Date, window: { timeZone: string; start: number; end: number; days: number[] }): Date {
  let t = new Date(Math.ceil(from.getTime() / STEP) * STEP);
  for (let i = 0; i < 96 * 8; i++) {
    const { hour, weekday } = localTime(t, window.timeZone);
    if (window.days.includes(weekday) && hour >= window.start && hour < window.end) return t;
    t = new Date(t.getTime() + STEP);
  }
  throw new Error("no contact window in the next 8 days; check the policy hours");
}

const contact = (i: GateInput) => isContactAction(i.proposal.action as Action);
/** Stop and escalate are how a case leaves the loop; caps, hours and approvals never block them. */
const terminal = (i: GateInput) => i.proposal.action === "stop" || i.proposal.action === "escalate_to_human";

export const RULES: readonly Rule[] = [
  {
    rule: 1,
    name: "already_resolved",
    check: (i) =>
      i.resolved
        ? {
            verdict: "block",
            effect: { kind: "close", endState: i.resolved },
            reason: i.resolved === "recovered" ? "case is already paid" : "case was cancelled or refunded",
          }
        : null,
  },
  {
    rule: 2,
    name: "dispute_open",
    check: (i) => (i.disputed ? { verdict: "block", effect: { kind: "escalate" }, reason: "a dispute is open; a person takes over" } : null),
  },
  {
    rule: 3,
    name: "opted_out",
    check: (i) => (i.optedOut ? { verdict: "block", effect: { kind: "stop" }, reason: "the customer asked not to be contacted" } : null),
  },
  {
    rule: 4,
    name: "kill_switch",
    check: (i) => (i.systemPaused ? { verdict: "block", effect: { kind: "pause" }, reason: "the operator has paused all activity" } : null),
  },
  {
    rule: 5,
    name: "action_whitelist",
    check: (i) => {
      const action = i.proposal.action;
      if (!isActionFor(i.lane, action)) return { verdict: "block", effect: { kind: "escalate" }, reason: `"${action}" is not on the ${i.lane} action menu` };
      const tool = ACTION_TOOL[action as Action];
      if (tool && !i.enabledTools.includes(tool)) return { verdict: "block", effect: { kind: "escalate" }, reason: `tool "${tool}" is not enabled for the ${i.lane} lane` };
      return null;
    },
  },
  {
    rule: 6,
    name: "attempt_cap",
    check: (i) => {
      if (!contact(i)) return null;
      if (i.contactsOnCase >= i.policy.caps.perCase) return { verdict: "block", effect: { kind: "escalate" }, reason: `case already has ${i.contactsOnCase} contacts (cap ${i.policy.caps.perCase})` };
      if (i.customerContactsLast7Days >= i.policy.caps.perCustomerPerWeek) {
        return { verdict: "block", effect: { kind: "escalate" }, reason: `customer had ${i.customerContactsLast7Days} contacts this week (cap ${i.policy.caps.perCustomerPerWeek})` };
      }
      return null;
    },
  },
  {
    rule: 7,
    name: "spacing",
    check: (i) => {
      if (!contact(i) || !i.lastContactAt) return null;
      const earliest = new Date(i.lastContactAt.getTime() + i.policy.thresholds.minGapHours * HOUR);
      return i.now < earliest ? { verdict: "block", effect: { kind: "retry_at", at: earliest }, reason: `minimum gap of ${i.policy.thresholds.minGapHours}h since last contact not reached` } : null;
    },
  },
  {
    rule: 8,
    name: "contact_hours",
    check: (i) => {
      if (!contact(i)) return null;
      const window = contactWindow(i);
      const { hour, weekday } = localTime(i.now, window.timeZone);
      if (window.days.includes(weekday) && hour >= window.start && hour < window.end) return null;
      return {
        verdict: "hold",
        effect: { kind: "retry_at", at: nextWindowStart(i.now, window) },
        reason: `outside contact hours (${window.start}:00-${window.end}:00 ${window.timeZone}, local time ${hour}:00)`,
      };
    },
  },
  {
    rule: 9,
    name: "amount_threshold",
    check: (i) =>
      !terminal(i) && !i.approvedByHuman && !isWaitOnly(i) && i.amountCents > i.policy.thresholds.approvalAmountCents
        ? { verdict: "hold", effect: { kind: "approval" }, reason: `case value ${(i.amountCents / 100).toFixed(2)} is above the approval limit` }
        : null,
  },
  {
    rule: 10,
    name: "confidence",
    check: (i) =>
      !terminal(i) && !i.approvedByHuman && i.proposal.confidence < i.policy.thresholds.confidenceFloor
        ? { verdict: "hold", effect: { kind: "approval" }, reason: `confidence ${i.proposal.confidence} is below the floor ${i.policy.thresholds.confidenceFloor}` }
        : null,
  },
  {
    rule: 11,
    name: "message_lint",
    check: (i) => {
      if (!i.messageLint || i.messageLint.ok) return null;
      const reason = `message failed lint: ${i.messageLint.issues.join("; ")}`;
      return i.redrafted ? { verdict: "hold", effect: { kind: "approval" }, reason } : { verdict: "block", effect: { kind: "redraft" }, reason };
    },
  },
  {
    rule: 12,
    name: "sensitive_action",
    check: (i) =>
      !i.approvedByHuman && isSensitiveAction(i.proposal.action as Action)
        ? { verdict: "hold", effect: { kind: "approval" }, reason: `"${i.proposal.action}" moves money and always needs a person's approval` }
        : null,
  },
];

/** Waiting costs nothing, so a large amount alone never needs approval to wait. */
function isWaitOnly(i: GateInput): boolean {
  return !contact(i) && !isSensitiveAction(i.proposal.action as Action);
}

/** Evaluates every rule and lets the first failing one decide. */
export function evaluateGate(input: GateInput): GateDecision {
  const checks: RuleResult[] = [];
  let decision: { rule: Rule; outcome: RuleOutcome } | null = null;
  for (const rule of RULES) {
    const outcome = rule.check(input);
    checks.push({ rule: rule.rule, name: rule.name, passed: outcome === null, ...(outcome ? { detail: outcome.reason } : {}) });
    if (outcome && !decision) decision = { rule, outcome };
  }
  if (!decision) {
    return { verdict: "allow", decidedBy: 0, effect: { kind: "proceed" }, reasons: [], checks, policyVersion: input.policy.version };
  }
  return {
    verdict: decision.outcome.verdict,
    decidedBy: decision.rule.rule,
    effect: decision.outcome.effect,
    reasons: [decision.outcome.reason],
    checks,
    policyVersion: input.policy.version,
  };
}
