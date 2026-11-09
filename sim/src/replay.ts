import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { proposeByRules, type Proposer } from "@boomerang/cases";
import { canonicalJson, simCaseResults, simRuns, type Database } from "@boomerang/db";
import { DEFAULT_POLICY, type Policy } from "@boomerang/policy";
import { pairedBootstrap, type Interval } from "./bootstrap";
import { parseSimConfig, type SimConfig } from "./config";
import { simulateArm, type CaseResult, type SimCase } from "./engine";
import { computeMetrics, type ArmMetrics } from "./metrics";
import { Rng } from "./rng";
import { findBatch, loadSimCases } from "./store";
import { loopStrategy, type TreatmentStats } from "./treatment";

/**
 * Phase 7A: what-if replay. A replay runs a stored batch's cases through Boomerang's real decision
 * path (diagnosis, proposer, policy gate, message lint) against the simulator, which stands in for
 * PayPal and the customers. Nothing is written and nothing reaches PayPal: the strategy only returns
 * contact kinds, and the simulator plays the customer's response (the dry executor, 7A.3).
 *
 * Deterministic by construction (7A.2): time is the simulator's virtual clock (SIM_EPOCH plus whole
 * days), and every random draw is keyed by the batch seed, the case and the purpose. Same input,
 * same policy -> byte-identical results.
 */

export interface ReplayInput {
  batchId: string;
  batchName: string;
  seed: string;
  config: SimConfig;
  /** In generation order (batch index), which is also the replay order. */
  cases: SimCase[];
}

/** 7A.1: the replay reader. One batch's stored cases (both arms, or one) with their simulator profiles, in order. */
export async function loadReplay(
  db: Database,
  batchIdOrLatest: string,
  arm?: "control" | "treatment",
): Promise<ReplayInput> {
  const batch = await findBatch(db, batchIdOrLatest);
  const cases = await loadSimCases(db, batch.id, arm);
  return {
    batchId: batch.id,
    batchName: batch.name,
    seed: batch.seed,
    config: parseSimConfig(batch.simConfig),
    cases,
  };
}

// 7A.4: policy overrides ------------------------------------------------------------------------------

/** The policy settings a what-if may change, each within a sane range. Unset fields keep the base policy. */
export const PolicyOverridesSchema = z
  .object({
    perCase: z.number().int().min(1).max(10),
    perCustomerPerWeek: z.number().int().min(1).max(14),
    minGapHours: z.number().int().min(1).max(336),
    approvalAmountCents: z.number().int().min(0).max(100_000_000),
    confidenceFloor: z.number().min(0).max(1),
    hoursStart: z.number().int().min(0).max(23),
    hoursEnd: z.number().int().min(1).max(24),
    contactDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  })
  .partial()
  .strict()
  .refine((o) => o.hoursStart === undefined || o.hoursEnd === undefined || o.hoursStart < o.hoursEnd, {
    message: "hoursStart must be before hoursEnd",
  });
export type PolicyOverrides = z.infer<typeof PolicyOverridesSchema>;

export function applyOverrides(base: Policy, o: PolicyOverrides): Policy {
  const start = o.hoursStart ?? base.hours.start;
  const end = o.hoursEnd ?? base.hours.end;
  if (start >= end) throw new Error(`contact window ${start}:00-${end}:00 is empty`);
  return {
    ...base,
    caps: {
      perCase: o.perCase ?? base.caps.perCase,
      perCustomerPerWeek: o.perCustomerPerWeek ?? base.caps.perCustomerPerWeek,
    },
    hours: {
      ...base.hours,
      start,
      end,
      days: o.contactDays ? [...new Set(o.contactDays)].sort() : base.hours.days,
    },
    thresholds: {
      approvalAmountCents: o.approvalAmountCents ?? base.thresholds.approvalAmountCents,
      confidenceFloor: o.confidenceFloor ?? base.thresholds.confidenceFloor,
      minGapHours: o.minGapHours ?? base.thresholds.minGapHours,
    },
  };
}

/** The policy a replay starts from: the default policy, live (a replay is a simulation, never a real send). */
export const REPLAY_BASE_POLICY: Policy = { ...DEFAULT_POLICY, mode: "live" };

// 7A.2: one replay -------------------------------------------------------------------------------------

export interface ReplayResult {
  policy: Policy;
  results: CaseResult[];
  metrics: ArmMetrics & { escalated: number; stopped: number; heldForApproval: number };
  stats: TreatmentStats;
  /** sha256 of the per-case results: equal fingerprints mean byte-identical replays. */
  fingerprint: string;
}

export async function replay(
  input: ReplayInput,
  options: { policy?: Policy; proposer?: Proposer; name?: string } = {},
): Promise<ReplayResult> {
  const policy = options.policy ?? REPLAY_BASE_POLICY;
  const strategy = loopStrategy({
    name: options.name ?? "boomerang-replay",
    proposer: options.proposer ?? proposeByRules,
    policy,
  });
  // A fresh Rng per replay: draws depend only on the seed and their keys, never on earlier draws.
  const results = await simulateArm(input.config, new Rng(input.seed), input.cases, strategy);
  const metrics = {
    ...computeMetrics(results),
    escalated: strategy.stats.escalated,
    stopped: strategy.stats.stopped,
    heldForApproval: strategy.stats.heldForApproval,
  };
  return { policy, results, metrics, stats: strategy.stats, fingerprint: fingerprint(results) };
}

export function fingerprint(results: readonly CaseResult[]): string {
  return createHash("sha256").update(JSON.stringify(results)).digest("hex");
}

// 7A.1: compare a replay with a stored run --------------------------------------------------------------

export interface RunComparison {
  runId: string;
  cases: number;
  matching: number;
  mismatches: { caseId: string; field: string; stored: unknown; replayed: unknown }[];
}

/** Compares a replay with a stored simulator run case by case (outcome, money, day, contacts, timeline). */
export async function compareWithStoredRun(
  db: Database,
  runId: string,
  results: readonly CaseResult[],
): Promise<RunComparison> {
  const stored = await db
    .select()
    .from(simCaseResults)
    .where(eq(simCaseResults.runId, runId))
    .orderBy(asc(simCaseResults.caseId));
  const byCase = new Map(results.map((r) => [r.caseId, r]));
  const mismatches: RunComparison["mismatches"] = [];
  for (const s of stored) {
    const r = byCase.get(s.caseId);
    if (!r) {
      mismatches.push({ caseId: s.caseId, field: "missing", stored: "present", replayed: "absent" });
      continue;
    }
    const pairs: [string, unknown, unknown][] = [
      ["outcome", s.outcome, r.outcome],
      ["recoveredCents", Number(s.recoveredCents), r.recoveredCents],
      ["recoveredDay", s.recoveredDay, r.recoveredDay],
      ["contacts", s.contacts, r.contacts],
      ["contactsAfterOptOut", s.contactsAfterOptOut, r.contactsAfterOptOut],
      // Canonical form: Postgres jsonb does not keep key order.
      ["timeline", canonicalJson(s.timeline), canonicalJson(r.timeline)],
    ];
    for (const [field, a, b] of pairs)
      if (a !== b) mismatches.push({ caseId: s.caseId, field, stored: a, replayed: b });
  }
  const bad = new Set(mismatches.map((m) => m.caseId));
  return { runId, cases: stored.length, matching: stored.length - bad.size, mismatches };
}

/** The most recent finished run of a strategy for a batch arm. */
export async function latestRun(
  db: Database,
  batchId: string,
  arm: "control" | "treatment",
  strategy: string,
) {
  const runs = await db
    .select()
    .from(simRuns)
    .where(and(eq(simRuns.batchId, batchId), eq(simRuns.arm, arm), eq(simRuns.strategy, strategy)))
    .orderBy(asc(simRuns.startedAt));
  return runs.filter((r) => r.finishedAt !== null).at(-1) ?? null;
}

// 7A.5: diff of two replays ------------------------------------------------------------------------------

export interface ReplayDiff {
  recoveredCents: { base: number; scenario: number; delta: number };
  recoveryRate: { base: number; scenario: number; deltaPoints: number };
  contacts: { base: number; scenario: number; delta: number };
  escalations: { base: number; scenario: number; delta: number };
  contactsAfterOptOut: { base: number; scenario: number; delta: number };
  /** Cases whose outcome, recovered amount or contact count changed. */
  casesChanged: number;
  casesNewlyRecovered: number;
  casesNoLongerRecovered: number;
}

/** Escalations per case are not in CaseResult, so they come from each replay's strategy totals. */
export function diffReplays(base: ReplayResult, scenario: ReplayResult): ReplayDiff {
  if (base.results.length !== scenario.results.length) throw new Error("replays cover different cases");
  const pair = (a: number, b: number) => ({ base: a, scenario: b, delta: b - a });
  let changed = 0;
  let newly = 0;
  let lost = 0;
  base.results.forEach((b, i) => {
    const s = scenario.results[i]!;
    if (s.caseId !== b.caseId) throw new Error("replays are not in the same case order");
    if (s.outcome !== b.outcome || s.recoveredCents !== b.recoveredCents || s.contacts !== b.contacts)
      changed++;
    if (b.recoveredCents === 0 && s.recoveredCents > 0) newly++;
    if (b.recoveredCents > 0 && s.recoveredCents === 0) lost++;
  });
  return {
    recoveredCents: pair(base.metrics.recoveredCents, scenario.metrics.recoveredCents),
    recoveryRate: {
      base: base.metrics.recoveryRate,
      scenario: scenario.metrics.recoveryRate,
      deltaPoints: (scenario.metrics.recoveryRate - base.metrics.recoveryRate) * 100,
    },
    contacts: pair(base.metrics.contacts, scenario.metrics.contacts),
    escalations: pair(base.metrics.escalated, scenario.metrics.escalated),
    contactsAfterOptOut: pair(base.metrics.contactsAfterOptOut, scenario.metrics.contactsAfterOptOut),
    casesChanged: changed,
    casesNewlyRecovered: newly,
    casesNoLongerRecovered: lost,
  };
}

// 7A.5 + 7A.6: one what-if ---------------------------------------------------------------------------

export interface WhatIfResult {
  batch: { id: string; name: string; cases: number };
  overrides: PolicyOverrides;
  base: ReplayResult["metrics"];
  scenario: ReplayResult["metrics"];
  diff: ReplayDiff;
  /** 95% paired-bootstrap intervals for the change in recovered dollars (cents) and recovery rate (points). */
  interval: { recoveredCents: Interval; recoveryRatePoints: Interval };
  fingerprints: { base: string; scenario: string };
  elapsedMs: number;
}

/**
 * Replays the batch under the current policy and under the overridden one, and reports the
 * difference with its interval. The base replay can be passed in (it only depends on the batch).
 */
export async function whatIf(
  input: ReplayInput,
  overrides: PolicyOverrides,
  options: { base?: ReplayResult; basePolicy?: Policy } = {},
): Promise<WhatIfResult> {
  const started = performance.now();
  const basePolicy = options.basePolicy ?? REPLAY_BASE_POLICY;
  const parsed = PolicyOverridesSchema.parse(overrides);
  const base = options.base ?? (await replay(input, { policy: basePolicy, name: "whatif-base" }));
  const scenario = await replay(input, {
    policy: applyOverrides(basePolicy, parsed),
    name: "whatif-scenario",
  });
  const boot = pairedBootstrap(
    base.results.map((r) => r.recoveredCents),
    scenario.results.map((r) => r.recoveredCents),
    {
      weights: base.results.map((r) => r.amountCents),
      seed: `whatif|${input.seed}|${JSON.stringify(parsed)}`,
    },
  );
  const toPoints = (i: Interval): Interval => ({
    ...i,
    estimate: i.estimate * 100,
    low: i.low * 100,
    high: i.high * 100,
  });
  return {
    batch: { id: input.batchId, name: input.batchName, cases: input.cases.length },
    overrides: parsed,
    base: base.metrics,
    scenario: scenario.metrics,
    diff: diffReplays(base, scenario),
    interval: { recoveredCents: boot.sum, recoveryRatePoints: toPoints(boot.rate!) },
    fingerprints: { base: base.fingerprint, scenario: scenario.fingerprint },
    elapsedMs: Math.round(performance.now() - started),
  };
}
