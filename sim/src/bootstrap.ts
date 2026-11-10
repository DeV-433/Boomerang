import { createHash } from "node:crypto";

/**
 * Step 7A.6: a paired bootstrap confidence interval, in-house (no stats package).
 *
 * Both replays cover the same cases, so cases are resampled as pairs: each resample draws n case
 * indices with replacement and recomputes the scenario-minus-base difference on those cases. The
 * interval is the percentile range of those differences. Seeded, so the same input gives the same
 * interval every time.
 */

/** mulberry32: a small, fast, seeded PRNG. Plenty for resampling; seedrandom is too slow for 600k draws. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seedFrom = (s: string) => createHash("sha256").update(s).digest().readUInt32LE(0);

/** Linear-interpolation percentile of a sorted array (p in [0, 1]). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error("percentile of an empty list");
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export interface Interval {
  estimate: number;
  low: number;
  high: number;
  level: number;
  iterations: number;
}

/**
 * Interval for sum(scenario) - sum(base) over paired observations, and optionally for the difference
 * in rates sum(.)/sum(weights) (recovery rate = recovered / at risk on the same resampled cases).
 */
export function pairedBootstrap(
  base: readonly number[],
  scenario: readonly number[],
  options: { iterations?: number; level?: number; seed?: string; weights?: readonly number[] } = {},
): { sum: Interval; rate?: Interval } {
  const n = base.length;
  if (n === 0 || scenario.length !== n) throw new Error("need two equally long, non-empty lists");
  if (options.weights && options.weights.length !== n) throw new Error("weights must match the observations");
  const iterations = options.iterations ?? 2000;
  const level = options.level ?? 0.95;
  const rand = mulberry32(seedFrom(options.seed ?? "boomerang-bootstrap"));
  const diffs = new Float64Array(n);
  for (let i = 0; i < n; i++) diffs[i] = scenario[i]! - base[i]!;
  const w = options.weights;

  const sums = new Array<number>(iterations);
  const rates = w ? new Array<number>(iterations) : null;
  for (let it = 0; it < iterations; it++) {
    let s = 0;
    let ws = 0;
    for (let j = 0; j < n; j++) {
      const k = Math.floor(rand() * n);
      s += diffs[k]!;
      if (w) ws += w[k]!;
    }
    sums[it] = s;
    if (rates) rates[it] = ws === 0 ? 0 : s / ws;
  }
  const tail = (1 - level) / 2;
  const interval = (values: number[], estimate: number): Interval => {
    values.sort((a, b) => a - b);
    return { estimate, low: percentile(values, tail), high: percentile(values, 1 - tail), level, iterations };
  };
  const total = diffs.reduce((a, b) => a + b, 0);
  const weightTotal = w ? w.reduce((a, b) => a + b, 0) : 0;
  return {
    sum: interval(sums, total),
    ...(rates ? { rate: interval(rates, weightTotal === 0 ? 0 : total / weightTotal) } : {}),
  };
}

/** Recovered and at-risk amounts of one arm, one entry per case. */
export interface ArmSample {
  recovered: readonly number[];
  atRisk: readonly number[];
}

/**
 * Step 9.1: interval for the difference in recovery rates between two different groups of cases
 * (treatment arm minus control arm). Unlike `pairedBootstrap`, the arms hold different cases, so
 * each is resampled on its own; the rate is recovered / at risk on the resampled cases.
 */
export function twoSampleBootstrap(
  control: ArmSample,
  treatment: ArmSample,
  options: { iterations?: number; level?: number; seed?: string } = {},
): Interval {
  for (const arm of [control, treatment]) {
    if (arm.recovered.length === 0 || arm.recovered.length !== arm.atRisk.length)
      throw new Error("each arm needs equally long, non-empty lists");
  }
  const iterations = options.iterations ?? 2000;
  const level = options.level ?? 0.95;
  const rand = mulberry32(seedFrom(options.seed ?? "boomerang-two-sample"));
  const rate = (arm: ArmSample, draw: boolean): number => {
    const n = arm.recovered.length;
    let rec = 0;
    let risk = 0;
    for (let j = 0; j < n; j++) {
      const k = draw ? Math.floor(rand() * n) : j;
      rec += arm.recovered[k]!;
      risk += arm.atRisk[k]!;
    }
    return risk === 0 ? 0 : rec / risk;
  };
  const diffs = new Array<number>(iterations);
  for (let it = 0; it < iterations; it++) diffs[it] = rate(treatment, true) - rate(control, true);
  diffs.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return {
    estimate: rate(treatment, false) - rate(control, false),
    low: percentile(diffs, tail),
    high: percentile(diffs, 1 - tail),
    level,
    iterations,
  };
}
