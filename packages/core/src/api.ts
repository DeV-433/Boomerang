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
