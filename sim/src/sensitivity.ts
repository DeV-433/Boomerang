import { proposeByRules, type Proposer } from "@boomerang/cases";
import { armKey, assignArms } from "./assign";
import { baselineStrategy } from "./baseline";
import { withOverrides, type SimConfig } from "./config";
import { simulateArm, type CaseResult, type SimCase } from "./engine";
import { planBatch } from "./generate";
import { computeMetrics, median } from "./metrics";
import { Rng } from "./rng";
import { loopStrategy, SIM_EPOCH } from "./treatment";
import { CUSTOMER_TYPES } from "./types";

/**
 * Step 9.2: how much the result depends on the simulator's assumptions. Each variation changes one
 * group of settings, applied to BOTH arms alike; each is run on several seeds. Batches are planned
 * in memory (no database, no PayPal), so a sweep is cheap and leaves nothing behind but its result.
 * The variations are fixed in code and chosen before looking at any result; never tune them to
 * make the uplift look better.
 */
export interface Variation {
  id: string;
  label: string;
  apply(draft: SimConfig): void;
}

/** Multiplies every pay and promise chance by k, shrinking a row back to a total of 1 if needed. */
function scaleResponses(c: SimConfig, k: number) {
  for (const rows of Object.values(c.responses)) {
    for (const row of Object.values(rows)) {
      if (!row) continue;
      row.pay *= k;
      row.promise *= k;
      const total = row.pay + row.promise + row.dispute + row.optOut;
      if (total > 1) {
        const room = Math.max(0, 1 - row.dispute - row.optOut);
        const s = room / (row.pay + row.promise);
        row.pay *= s;
        row.promise *= s;
      }
    }
  }
}

/** Moves `share` of each lane's mix from one customer type to another (keeps the mix summing to 1). */
function shiftMix(
  c: SimConfig,
  from: (typeof CUSTOMER_TYPES)[number],
  to: (typeof CUSTOMER_TYPES)[number],
  share: number,
) {
  for (const lane of ["invoice", "subscription"] as const) {
    const mix = c.batch.typeMix[lane];
    const moved = Math.min(share, mix[from] ?? 0);
    mix[from] = (mix[from] ?? 0) - moved;
    mix[to] = (mix[to] ?? 0) + moved;
  }
}

export const VARIATIONS: readonly Variation[] = [
  { id: "base", label: "As configured", apply: () => {} },
  { id: "responses-low", label: "Customers 30% less responsive", apply: (c) => scaleResponses(c, 0.7) },
  { id: "responses-high", label: "Customers 30% more responsive", apply: (c) => scaleResponses(c, 1.3) },
  {
    id: "fatigue-strong",
    label: "Stronger message fatigue",
    apply: (c) => {
      c.fatigue.perPriorContact = 0.7;
      c.fatigue.optOutIncreasePerPriorContact = 0.04;
    },
  },
  {
    id: "fatigue-none",
    label: "No message fatigue",
    apply: (c) => {
      c.fatigue.perPriorContact = 1;
      c.fatigue.optOutIncreasePerPriorContact = 0;
    },
  },
  {
    id: "selfpay-half",
    label: "Half as much unprompted payment",
    apply: (c) => {
      for (const t of CUSTOMER_TYPES) c.dailySelfPay[t] /= 2;
    },
  },
  {
    id: "selfpay-double",
    label: "Twice as much unprompted payment",
    apply: (c) => {
      for (const t of CUSTOMER_TYPES) c.dailySelfPay[t] = Math.min(1, c.dailySelfPay[t] * 2);
    },
  },
  {
    id: "promises-weak",
    label: "Promises kept 20 points less often",
    apply: (c) => {
      for (const t of CUSTOMER_TYPES)
        c.promise.keepProbability[t] = Math.max(0, c.promise.keepProbability[t] - 0.2);
    },
  },
  {
    id: "more-opt-outs",
    label: "10 points more opt-out-prone customers",
    apply: (c) => shiftMix(c, "would_pay_after_nudge", "opts_out", 0.1),
  },
  {
    id: "more-disputers",
    label: "5 points more disputers",
    apply: (c) => shiftMix(c, "would_pay_after_nudge", "disputer", 0.05),
  },
  {
    id: "invoice-heavy",
    label: "85% invoices",
    apply: (c) => {
      c.batch.laneMix = { invoice: 0.85, subscription: 0.15 };
    },
  },
  {
    id: "subscription-heavy",
    label: "70% subscriptions",
    apply: (c) => {
      c.batch.laneMix = { invoice: 0.3, subscription: 0.7 };
    },
  },
];

export interface SensitivityCell {
  variation: string;
  seed: string;
  cases: number;
  controlRate: number;
  treatmentRate: number;
  /** The treatment arm's cases under the baseline. */
  baselineOnTreatmentRate: number;
  /** Percentage points. */
  upliftVsControl: number;
  upliftSameCases: number;
  /** Boomerang's contacts to customers who had opted out (must be 0). */
  contactsAfterOptOut: number;
}

export interface Spread {
  min: number;
  median: number;
  max: number;
  /** Share of cells above zero. */
  positiveShare: number;
}

export interface SensitivitySummary {
  strategy: string;
  size: number;
  seeds: string[];
  variations: { id: string; label: string; sameCases: Spread; vsControl: Spread }[];
  overall: { sameCases: Spread; vsControl: Spread };
  cells: SensitivityCell[];
}

export function spread(values: readonly number[]): Spread {
  if (values.length === 0) throw new Error("spread of an empty list");
  return {
    min: Math.min(...values),
    median: median(values)!,
    max: Math.max(...values),
    positiveShare: values.filter((v) => v > 0).length / values.length,
  };
}

/** A batch planned in memory, split into arms exactly as the seeder would. */
export function plannedArms(config: SimConfig, seed: string, size: number) {
  const plan = planBatch(config, seed, size, SIM_EPOCH);
  const all: SimCase[] = plan.cases.map((p) => ({
    caseId: `${seed}-${p.profile.batchIndex}`,
    lane: p.profile.lane,
    amountCents: p.amountCents,
    profile: p.profile,
    visible: { reasonCode: p.subscription?.reasonCode ?? null, timezone: p.customer.timezone },
  }));
  // Keyed by batch position, exactly as the seeder does, so the split matches a seeded batch.
  const arms = assignArms(
    all.map((c) => ({ id: armKey(c.profile.batchIndex), lane: c.lane, amountCents: c.amountCents })),
    seed,
  );
  return {
    control: all.filter((c) => arms.get(armKey(c.profile.batchIndex)) === "control"),
    treatment: all.filter((c) => arms.get(armKey(c.profile.batchIndex)) === "treatment"),
  };
}

const rate = (rs: readonly CaseResult[]) => computeMetrics(rs).recoveryRate;

export async function runSensitivity(options: {
  base: SimConfig;
  seeds: readonly string[];
  size?: number;
  variations?: readonly Variation[];
  proposer?: Proposer;
  strategyName?: string;
  onCell?: (cell: SensitivityCell, done: number, total: number) => void;
}): Promise<SensitivitySummary> {
  const size = options.size ?? options.base.batch.size;
  const variations = options.variations ?? VARIATIONS;
  const strategyName = options.strategyName ?? "boomerang-rules";
  const total = variations.length * options.seeds.length;
  const cells: SensitivityCell[] = [];
  for (const v of variations) {
    const config = withOverrides(options.base, v.apply);
    for (const seed of options.seeds) {
      const { control, treatment } = plannedArms(config, seed, size);
      const rng = new Rng(seed);
      const strategy = loopStrategy({ name: strategyName, proposer: options.proposer ?? proposeByRules });
      const [c, t, b] = [
        await simulateArm(config, rng, control, baselineStrategy(config)),
        await simulateArm(config, rng, treatment, strategy),
        await simulateArm(config, rng, treatment, baselineStrategy(config)),
      ];
      const cell: SensitivityCell = {
        variation: v.id,
        seed,
        cases: control.length + treatment.length,
        controlRate: rate(c),
        treatmentRate: rate(t),
        baselineOnTreatmentRate: rate(b),
        upliftVsControl: (rate(t) - rate(c)) * 100,
        upliftSameCases: (rate(t) - rate(b)) * 100,
        contactsAfterOptOut: t.reduce((s, r) => s + r.contactsAfterOptOut, 0),
      };
      cells.push(cell);
      options.onCell?.(cell, cells.length, total);
    }
  }
  const of = (rows: SensitivityCell[]) => ({
    sameCases: spread(rows.map((r) => r.upliftSameCases)),
    vsControl: spread(rows.map((r) => r.upliftVsControl)),
  });
  return {
    strategy: strategyName,
    size,
    seeds: [...options.seeds],
    variations: variations.map((v) => ({
      id: v.id,
      label: v.label,
      ...of(cells.filter((c) => c.variation === v.id)),
    })),
    overall: of(cells),
    cells,
  };
}
