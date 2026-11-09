import seedrandom from "seedrandom";

/**
 * Step 3.2: seeded randomness. Every draw is keyed by what it is for (case, purpose, day, ...),
 * not by how many draws came before. So one case's events never shift another case's numbers,
 * a policy change only changes the draws it actually touches (what-if replays, 7A), and the
 * same seed always reproduces the same batch and the same run.
 */
export class Rng {
  constructor(readonly seed: string) {}

  /** A uniform number in [0, 1) fixed by the seed and the keys. */
  draw(...keys: (string | number)[]): number {
    return seedrandom(`${this.seed}|${keys.join("|")}`)();
  }

  chance(p: number, ...keys: (string | number)[]): boolean {
    return this.draw(...keys) < p;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number, ...keys: (string | number)[]): number {
    return min + Math.floor(this.draw(...keys) * (max - min + 1));
  }

  pick<T>(items: readonly T[], ...keys: (string | number)[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[Math.floor(this.draw(...keys) * items.length)]!;
  }

  /** Picks a key of `weights` with probability proportional to its weight. */
  weighted<K extends string>(
    weights: Record<K, number> | Partial<Record<K, number>>,
    ...keys: (string | number)[]
  ): K {
    const entries = Object.entries(weights) as [K, number][];
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.draw(...keys) * total;
    for (const [key, w] of entries) {
      roll -= w;
      if (roll < 0) return key;
    }
    return entries[entries.length - 1]![0];
  }

  /** Standard normal via Box-Muller, from two keyed draws. */
  normal(...keys: (string | number)[]): number {
    const u = Math.max(this.draw(...keys, "u"), Number.EPSILON);
    const v = this.draw(...keys, "v");
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Fisher-Yates shuffle (copy), keyed so it is reproducible. */
  shuffle<T>(items: readonly T[], ...keys: (string | number)[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.draw(...keys, i) * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /** Random id made of uppercase letters and digits. */
  id(length: number, ...keys: (string | number)[]): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from(
      { length },
      (_, i) => alphabet[Math.floor(this.draw(...keys, i) * alphabet.length)],
    ).join("");
  }
}
