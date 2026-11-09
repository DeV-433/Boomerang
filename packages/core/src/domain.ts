/**
 * Boomerang's domain vocabulary: lanes, case states, causes and the closed action menus.
 * Pure data and types, shared by the policy gate, the loop, the agent and the dashboard.
 */

export const LANES = ["invoice", "subscription"] as const;
export type Lane = (typeof LANES)[number];

// 4.1: case state machine ------------------------------------------------------------------------------

export const CASE_STATES = [
  "detected",
  "diagnosed",
  "proposed",
  "approval",
  "executed",
  "awaiting",
  "recovered",
  "stopped",
  "escalated",
] as const;
export type CaseState = (typeof CASE_STATES)[number];

export const END_STATES = ["recovered", "stopped", "escalated"] as const satisfies readonly CaseState[];
export type EndState = (typeof END_STATES)[number];

export const isEndState = (state: CaseState): state is EndState => (END_STATES as readonly string[]).includes(state);

/** Every state a case can leave for an end state when a stop condition or payment arrives. */
const TO_ENDS = [...END_STATES];

/**
 * Legal transitions (section 8 of the project documentation). End states have none: a recovered
 * amount is counted once, and a stopped case cannot be contacted again by a late job.
 */
export const TRANSITIONS: Readonly<Record<CaseState, readonly CaseState[]>> = {
  detected: ["diagnosed", ...TO_ENDS],
  diagnosed: ["proposed", ...TO_ENDS],
  // allow + contact -> executed; hold for a person -> approval; wait, defer or block-until -> awaiting
  proposed: ["approval", "executed", "awaiting", ...TO_ENDS],
  // approve -> executed; reject -> stopped; deferred by contact hours after approval -> awaiting
  approval: ["executed", "awaiting", ...TO_ENDS],
  executed: ["awaiting", ...TO_ENDS],
  // next check with no outcome -> diagnosed again at the next stage
  awaiting: ["diagnosed", ...TO_ENDS],
  recovered: [],
  stopped: [],
  escalated: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: CaseState,
    readonly to: CaseState,
  ) {
    super(`Illegal case transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: CaseState, to: CaseState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Returns `to` if the move is legal, otherwise throws. */
export function transition(from: CaseState, to: CaseState): CaseState {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

// 4.5: causes ------------------------------------------------------------------------------------------

export const CAUSES = {
  subscription: ["temporary_decline", "expired_funding_source", "threshold_reached", "cancelled_with_balance"],
  invoice: ["overdue_no_engagement", "overdue_unresponsive", "promise_to_pay", "broken_promise"],
  any: ["dispute", "opted_out", "resolved"],
} as const;
export type SubscriptionCause = (typeof CAUSES.subscription)[number];
export type InvoiceCause = (typeof CAUSES.invoice)[number];
export type SharedCause = (typeof CAUSES.any)[number];
export type Cause = SubscriptionCause | InvoiceCause | SharedCause;
export const ALL_CAUSES: readonly Cause[] = [...CAUSES.subscription, ...CAUSES.invoice, ...CAUSES.any];

// 4.6: action menus as typed enums ---------------------------------------------------------------------

export const ACTION_MENUS = {
  invoice: ["send_reminder", "offer_payment_plan", "schedule_promise_check", "wait", "escalate_to_human", "stop"],
  subscription: [
    "send_update_payment_message",
    "wait_for_paypal_retry",
    "request_balance_capture",
    "schedule_follow_up",
    "escalate_to_human",
    "stop",
  ],
} as const satisfies Record<Lane, readonly string[]>;

export type InvoiceAction = (typeof ACTION_MENUS.invoice)[number];
export type SubscriptionAction = (typeof ACTION_MENUS.subscription)[number];
export type ActionFor<L extends Lane> = (typeof ACTION_MENUS)[L][number];
export type Action = InvoiceAction | SubscriptionAction;

export function isActionFor<L extends Lane>(lane: L, action: string): action is ActionFor<L> {
  return (ACTION_MENUS[lane] as readonly string[]).includes(action);
}

/** Actions that send a message to the customer. Caps, spacing and contact hours apply to these. */
export const CONTACT_ACTIONS = ["send_reminder", "offer_payment_plan", "send_update_payment_message"] as const satisfies readonly Action[];
export const isContactAction = (action: Action): boolean => (CONTACT_ACTIONS as readonly string[]).includes(action);

/** Actions that move money or change something beyond a reminder: always held for a person (gate rule 12). */
export const SENSITIVE_ACTIONS = ["request_balance_capture"] as const satisfies readonly Action[];
export const isSensitiveAction = (action: Action): boolean => (SENSITIVE_ACTIONS as readonly string[]).includes(action);

/** Actions that only reschedule the case; nothing leaves Boomerang. */
export const WAIT_ACTIONS = ["wait", "schedule_promise_check", "wait_for_paypal_retry", "schedule_follow_up"] as const satisfies readonly Action[];
export const isWaitAction = (action: Action): boolean => (WAIT_ACTIONS as readonly string[]).includes(action);

/**
 * The PayPal operation each action needs. `null` means no PayPal call: internal scheduling, a
 * hand-off to a person, or a message delivered by logging (PayPal has no subscriber-message tool,
 * and the project sends no real email; decision 0.6).
 */
export const ACTION_TOOL: Readonly<Record<Action, string | null>> = {
  send_reminder: "send_invoice_reminder",
  offer_payment_plan: "send_invoice_reminder",
  schedule_promise_check: null,
  wait: null,
  escalate_to_human: null,
  stop: null,
  send_update_payment_message: null,
  wait_for_paypal_retry: null,
  request_balance_capture: "capture_subscription_balance",
  schedule_follow_up: null,
};

export type Tone = "friendly" | "neutral" | "firm";

/** Tone is set by escalation stage, never by the model (section 6). */
export function toneForStage(stage: number): Tone {
  return stage <= 0 ? "friendly" : stage === 1 ? "neutral" : "firm";
}

/** After this many contact stages Boomerang sends nothing more and hands the case to the operator. */
export const MAX_CONTACT_STAGES = 3;

/** A proposal from the rule-based proposer or the agent (section 6, structured output). */
export interface Proposal {
  caseId: string;
  cause: Cause;
  action: Action;
  reason: string;
  /** 0 to 1. Rules report a fixed value; the agent's is a weak signal (gate rule 10). */
  confidence: number;
  message?: { tone: Tone; template: string; subject?: string; body: string };
  nextCheckAfterHours: number;
  proposedBy: string;
}
