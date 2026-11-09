/**
 * Dashboard API contract (Phase 6). Types only, so the browser bundle can import them from
 * @boomerang/core without pulling in server code. Money is always integer cents.
 */

export interface ArmTotals {
  cases: number;
  atRiskCents: number;
  recoveredCents: number;
  recoveredCases: number;
  /** recoveredCents / atRiskCents (0 when nothing is at risk). */
  recoveryRate: number;
}

/** The simulator's per-arm metrics, as computed by sim/src/metrics.ts and stored with each run. */
export interface SimArmMetrics extends ArmTotals {
  contacts: number;
  contactsPerRecoveredDollar: number | null;
  medianDaysToRecovery: number | null;
  disputes: number;
  optOuts: number;
  contactsAfterOptOut: number;
  escalated?: number;
  heldForApproval?: number;
  modelCostPerRecoveredDollar?: number | null;
  model?: {
    all: {
      calls: number;
      cachedCalls: number;
      inputTokens: number;
      outputTokens: number;
      thinkingTokens: number;
      costUsd: number;
    };
  } | null;
}

export interface SimRunInfo {
  id: string;
  arm: "control" | "treatment";
  strategy: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface SummaryResponse {
  batch: {
    id: string;
    name: string;
    seed: string;
    size: number;
    mode: string;
    createdAt: string;
    startedAt: string | null;
  } | null;
  /** Real cases in the database for this batch, by arm. Before the batch is started only control-arm baselines change. */
  live: { control: ArmTotals; treatment: ArmTotals; upliftPoints: number | null };
  /** Cases that arrived from PayPal outside any batch. */
  organic: ArmTotals;
  /** The latest simulated control run and the chosen (default: latest agent) treatment run. */
  simulated: {
    control: (SimRunInfo & { metrics: SimArmMetrics }) | null;
    treatment: (SimRunInfo & { metrics: SimArmMetrics }) | null;
    /** Treatment recovery rate minus control recovery rate, in percentage points. */
    upliftPoints: number | null;
    runs: SimRunInfo[];
  };
  system: { paused: boolean; mode: "dry_run" | "live" };
}

// 6.4: cases ----------------------------------------------------------------------------------------

export const CASE_SORT_FIELDS = [
  "openedAt",
  "amountCents",
  "recoveredCents",
  "state",
  "cause",
  "stage",
  "lastContactAt",
  "nextCheckAt",
  "lane",
  "customer",
] as const;
export type CaseSortField = (typeof CASE_SORT_FIELDS)[number];
export const CASE_GROUP_FIELDS = ["cause", "state", "lane", "arm"] as const;
export type CaseGroupField = (typeof CASE_GROUP_FIELDS)[number];

export interface CaseRow {
  id: string;
  paypalRef: string;
  lane: "invoice" | "subscription";
  customer: string | null;
  customerEmail: string | null;
  amountCents: number;
  currency: string;
  cause: string | null;
  state: string;
  stage: number;
  contacts: number;
  lastContactAt: string | null;
  nextCheckAt: string | null;
  recoveredCents: number;
  arm: "control" | "treatment" | null;
  batchId: string | null;
  paused: boolean;
  simulated: boolean;
  openedAt: string;
  closedAt: string | null;
  closedReason: string | null;
}

export interface CasesResponse {
  rows: CaseRow[];
  /** Matching cases across all pages. */
  total: number;
  offset: number;
  limit: number;
}

export interface CaseGroup {
  /** The group's value (null for cases with no cause yet). */
  key: string | null;
  cases: number;
  amountCents: number;
  recoveredCents: number;
}

export interface CaseGroupsResponse {
  by: CaseGroupField;
  groups: CaseGroup[];
}

// 6.7 and 6.8: audit ------------------------------------------------------------------------------

export const AUDIT_ENTRY_KINDS = [
  "event_received",
  "diagnosed",
  "proposed",
  "gated",
  "approval",
  "executed",
  "observed",
  "closed",
  "scheduled",
  "system",
] as const;
export type AuditEntryKind = (typeof AUDIT_ENTRY_KINDS)[number];

export interface AuditEntry {
  id: number;
  caseId: string | null;
  at: string;
  actor: string;
  kind: AuditEntryKind;
  data: Record<string, unknown>;
  hash: string;
  prevHash: string | null;
}

/** One row of the audit screen: an entry plus enough of its case to recognise it. */
export interface AuditListRow extends AuditEntry {
  paypalRef: string | null;
  lane: "invoice" | "subscription" | null;
  caseState: string | null;
}

export interface AuditListResponse {
  rows: AuditListRow[];
  total: number;
  offset: number;
  limit: number;
}

export interface CaseAuditResponse {
  caseId: string;
  paypalRef: string;
  state: string;
  /** The case's whole trail, oldest first (chain order). */
  entries: AuditEntry[];
}

// 6.9 and 6.10: approvals ---------------------------------------------------------------------------

export interface DraftMessage {
  subject: string;
  body: string;
  tone: string;
  template: string;
  personalNote?: string;
}

export interface ApprovalRow {
  approvalId: string;
  actionId: string;
  status: "pending" | "approved" | "edited" | "rejected";
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
  case: {
    id: string;
    paypalRef: string;
    lane: "invoice" | "subscription";
    customer: string | null;
    amountCents: number;
    currency: string;
    stage: number;
    state: string;
  };
  action: string;
  proposedBy: string;
  /** The proposer's own reason (rules or model). */
  reason: string | null;
  confidence: number | null;
  message: DraftMessage | null;
  /** Why the gate held it for a person. */
  gate: { verdict: string | null; reasons: string[] };
  /** The customer's latest reply, verbatim and untrusted: shown apart from the agent's reasoning. */
  customerReply: { text: string; receivedAt: string; label: string | null } | null;
}

export interface ApprovalsResponse {
  rows: ApprovalRow[];
}

export interface ApprovalDecisionRequest {
  decision: "approve" | "edit" | "reject";
  note?: string;
  /** For "edit": the operator's new subject and body. The body must still pass the message lint. */
  message?: { subject?: string; body: string };
}

export interface ApprovalDecisionResponse {
  /** What happened next: sent (executed), held for later (deferred), closed, or nothing pending (skipped). */
  outcome: string;
  detail: string | null;
}

// 6.11: global pause ----------------------------------------------------------------------------------

export interface SystemStatus {
  paused: boolean;
  pausedBy: string | null;
  changedAt: string | null;
  mode: "dry_run" | "live";
}

// 7A: what-if ----------------------------------------------------------------------------------------

/** Policy settings a what-if may change (validated server-side; unset keeps the current policy). */
export interface WhatIfOverrides {
  perCase?: number;
  perCustomerPerWeek?: number;
  minGapHours?: number;
  approvalAmountCents?: number;
  confidenceFloor?: number;
  hoursStart?: number;
  hoursEnd?: number;
  contactDays?: number[];
}

export interface WhatIfMetrics {
  cases: number;
  atRiskCents: number;
  recoveredCents: number;
  recoveredCases: number;
  recoveryRate: number;
  contacts: number;
  contactsAfterOptOut: number;
  disputes: number;
  optOuts: number;
  escalated: number;
  stopped: number;
  heldForApproval: number;
  medianDaysToRecovery: number | null;
}

export interface WhatIfInterval {
  estimate: number;
  low: number;
  high: number;
  level: number;
  iterations: number;
}

export interface WhatIfResponse {
  batch: { id: string; name: string; cases: number };
  overrides: WhatIfOverrides;
  base: WhatIfMetrics;
  scenario: WhatIfMetrics;
  diff: {
    recoveredCents: { base: number; scenario: number; delta: number };
    recoveryRate: { base: number; scenario: number; deltaPoints: number };
    contacts: { base: number; scenario: number; delta: number };
    escalations: { base: number; scenario: number; delta: number };
    contactsAfterOptOut: { base: number; scenario: number; delta: number };
    casesChanged: number;
    casesNewlyRecovered: number;
    casesNoLongerRecovered: number;
  };
  interval: { recoveredCents: WhatIfInterval; recoveryRatePoints: WhatIfInterval };
  fingerprints: { base: string; scenario: string };
  elapsedMs: number;
}

/** The policy a what-if starts from, so the screen can show current values next to the sliders. */
export interface WhatIfDefaults {
  perCase: number;
  perCustomerPerWeek: number;
  minGapHours: number;
  approvalAmountCents: number;
  confidenceFloor: number;
  hoursStart: number;
  hoursEnd: number;
  contactDays: number[];
}

// 7A.9: saved scenarios ---------------------------------------------------------------------------------

export interface SavedScenario {
  id: string;
  name: string;
  batchId: string;
  overrides: WhatIfOverrides;
  result: WhatIfResponse;
  createdAt: string;
}

export interface ScenarioReloadResponse {
  scenario: SavedScenario;
  result: WhatIfResponse;
  /** True when the fresh replay reproduced the saved fingerprints and diff exactly. */
  sameResult: boolean;
}

// 7B: trust panel -----------------------------------------------------------------------------------

export type AuditVerifyResponse = (
  | { ok: true; checked: number; lastId: number | null; lastHash: string | null; legacyDateEntries: number[] }
  | {
      ok: false;
      checked: number;
      brokenAt: number;
      reason: "hash_mismatch" | "broken_link";
      expected: string;
      found: string | null;
    }
) & { verifiedAt: string; ms: number };

export interface TamperDemoResponse {
  edited: { id: number; kind: string; actor: string; change: string };
  copy: AuditVerifyResponse;
  real: AuditVerifyResponse;
  rolledBack: true;
}

export interface AttackRunResult {
  attack: { id: string; name: string; category: string };
  classification: { label: string; promiseDate: string | null };
  proposal: { action: string; proposedBy: string; reason: string };
  gate: { verdict: string; decidedBy: number; reason: string | null };
  wouldCall: string | null;
  toolCallsMade: string[];
  checks: Record<string, boolean>;
  passed: boolean;
}

export interface TrustSuiteResponse {
  /** "worst_case": both models replaced by ones that do what the attacker asks. */
  mode: "worst_case";
  passed: number;
  total: number;
  results: AttackRunResult[];
  ms: number;
}

export interface TrustAttackResponse {
  /** "live": the real reply classifier and decision model; "rules": classifier unavailable, so worst case on the label. */
  mode: "live" | "worst_case";
  result: AttackRunResult;
  ms: number;
}
