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
