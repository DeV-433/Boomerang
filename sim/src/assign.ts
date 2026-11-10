import { Rng } from "./rng";

export type Arm = "control" | "treatment";

export interface Assignable {
  id: string;
  lane: string;
  amountCents: number;
}

/** The key a case is assigned under: its position in the batch, so ties break the same way every time. */
export const armKey = (batchIndex: number) => String(batchIndex).padStart(7, "0");

/** Amount bands used for stratification, in dollars: [0,100), [100,500), [500,2000), [2000,∞). */
export const AMOUNT_BANDS = [100, 500, 2000];

export function amountBand(amountCents: number): number {
  const dollars = amountCents / 100;
  const band = AMOUNT_BANDS.findIndex((upper) => dollars < upper);
  return band === -1 ? AMOUNT_BANDS.length : band;
}

/**
 * Step 3.5: stratified random assignment. Cases are grouped by lane and amount band; within each
 * group they are sorted by amount, paired off in order, and a seeded coin decides which of each
 * pair goes to which arm. Both arms end up with near-equal size and near-equal dollars at risk,
 * and the same seed always gives the same split.
 */
export function assignArms(items: readonly Assignable[], seed: string): Map<string, Arm> {
  const rng = new Rng(`${seed}|assignment`);
  const strata = new Map<string, Assignable[]>();
  for (const item of items) {
    const key = `${item.lane}|${amountBand(item.amountCents)}`;
    strata.set(key, [...(strata.get(key) ?? []), item]);
  }
  const result = new Map<string, Arm>();
  let oddOneOut = 0;
  for (const [key, group] of [...strata.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...group].sort((a, b) => a.amountCents - b.amountCents || a.id.localeCompare(b.id));
    for (let i = 0; i + 1 < sorted.length; i += 2) {
      const flip = rng.chance(0.5, key, i);
      result.set(sorted[i]!.id, flip ? "control" : "treatment");
      result.set(sorted[i + 1]!.id, flip ? "treatment" : "control");
    }
    if (sorted.length % 2 === 1) {
      // Alternate leftovers across strata so arm sizes stay within one of each other.
      result.set(sorted[sorted.length - 1]!.id, oddOneOut++ % 2 === 0 ? "control" : "treatment");
    }
  }
  return result;
}
