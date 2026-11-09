import { asc, gte, sql } from "drizzle-orm";
import { auditLog, computeAuditHash, type Database } from "@boomerang/db";

export type ChainVerdict =
  | {
      ok: true;
      checked: number;
      lastId: number | null;
      lastHash: string | null;
      /** Entries written before the date-hashing fix whose date values were not covered by their hash (disclosed, not hidden). */
      legacyDateEntries: number[];
    }
  | {
      ok: false;
      checked: number;
      brokenAt: number;
      reason: "hash_mismatch" | "broken_link";
      expected: string;
      found: string | null;
    };

/**
 * Walks the audit log in id order and reports the first entry whose stored hash no longer matches
 * its content (it was edited) or whose prev_hash does not match the entry before it (an entry was
 * removed or inserted). `fromId` verifies a segment, starting from that entry's own stored link.
 */
export async function verifyChain(
  db: Database,
  options: { fromId?: number; batchSize?: number } = {},
): Promise<ChainVerdict> {
  const batchSize = options.batchSize ?? 1000;
  let cursor = options.fromId ?? 0;
  let expectedPrev: string | null | undefined; // undefined: take the first entry's stored link as given
  let checked = 0;
  let last: { id: number; hash: string } | null = null;
  const legacyDateEntries: number[] = [];
  if (options.fromId === undefined) expectedPrev = null;

  for (;;) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(gte(auditLog.id, cursor))
      .orderBy(asc(auditLog.id))
      .limit(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (expectedPrev !== undefined && row.prevHash !== expectedPrev) {
        return {
          ok: false,
          checked,
          brokenAt: row.id,
          reason: "broken_link",
          expected: expectedPrev ?? "null",
          found: row.prevHash,
        };
      }
      const fields = { caseId: row.caseId, at: row.at, actor: row.actor, kind: row.kind };
      const recomputed = computeAuditHash(row.prevHash, { ...fields, data: row.data });
      if (
        recomputed !== row.hash &&
        row.at < LEGACY_DATE_HASH_BEFORE &&
        legacyDateVariants(row.data).some(
          (d) => computeAuditHash(row.prevHash, { ...fields, data: d }) === row.hash,
        )
      ) {
        legacyDateEntries.push(row.id);
      } else if (recomputed !== row.hash) {
        return {
          ok: false,
          checked,
          brokenAt: row.id,
          reason: "hash_mismatch",
          expected: recomputed,
          found: row.hash,
        };
      }
      expectedPrev = row.hash;
      last = { id: row.id, hash: row.hash };
      checked++;
    }
    cursor = rows[rows.length - 1]!.id + 1;
  }
  return { ok: true, checked, lastId: last?.id ?? null, lastHash: last?.hash ?? null, legacyDateEntries };
}

/** Audit entries for one case, oldest first. */
export async function caseTrail(db: Database, caseId: string) {
  return db
    .select()
    .from(auditLog)
    .where(sql`${auditLog.caseId} = ${caseId}`)
    .orderBy(asc(auditLog.id));
}

/**
 * Entries timestamped before this were hashed by the old canonicalJson, which turned a Date inside
 * `data` into {}. For those only, a mismatch that the old date handling explains is accepted and
 * listed. `at` is itself hashed, so an entry cannot be back-dated into this window undetected.
 */
export const LEGACY_DATE_HASH_BEFORE = new Date("2026-11-10T00:00:00Z");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Most date-valued fields any entry kind carries; bounds the 2^k search below. */
const MAX_LEGACY_DATE_FIELDS = 8;

/**
 * Hash version 1 (entries written before 2026-11-10) hashed a JavaScript Date inside `data` as {}
 * instead of its ISO string; jsonb then stored the ISO string. A stored ISO string may have been a
 * Date (hashed as {}) or already a string (hashed as itself), so this yields every combination of
 * ISO strings turned back into {}, smallest changes first. Empty when there are too many to try.
 */
export function legacyDateVariants(data: unknown): unknown[] {
  const paths: (string | number)[][] = [];
  const walk = (v: unknown, path: (string | number)[]) => {
    if (typeof v === "string" && ISO_DATE.test(v)) paths.push(path);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
  };
  walk(data, []);
  if (paths.length === 0 || paths.length > MAX_LEGACY_DATE_FIELDS) return [];
  const variants: unknown[] = [];
  const masks = Array.from({ length: 2 ** paths.length - 1 }, (_, i) => i + 1).sort(
    (a, b) => popcount(a) - popcount(b),
  );
  for (const mask of masks) {
    const copy = structuredClone(data) as Record<string | number, unknown>;
    paths.forEach((p, i) => {
      if (!(mask & (1 << i))) return;
      let node = copy as Record<string | number, unknown>;
      for (const key of p.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
      node[p[p.length - 1]!] = {};
    });
    variants.push(copy);
  }
  return variants;
}

function popcount(n: number): number {
  let c = 0;
  for (; n; n &= n - 1) c++;
  return c;
}
