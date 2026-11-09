import { asc, gte, sql } from "drizzle-orm";
import { auditLog, computeAuditHash, type Database } from "@boomerang/db";

export type ChainVerdict =
  | { ok: true; checked: number; lastId: number | null; lastHash: string | null }
  | { ok: false; checked: number; brokenAt: number; reason: "hash_mismatch" | "broken_link"; expected: string; found: string | null };

/**
 * Walks the audit log in id order and reports the first entry whose stored hash no longer matches
 * its content (it was edited) or whose prev_hash does not match the entry before it (an entry was
 * removed or inserted). `fromId` verifies a segment, starting from that entry's own stored link.
 */
export async function verifyChain(db: Database, options: { fromId?: number; batchSize?: number } = {}): Promise<ChainVerdict> {
  const batchSize = options.batchSize ?? 1000;
  let cursor = options.fromId ?? 0;
  let expectedPrev: string | null | undefined; // undefined: take the first entry's stored link as given
  let checked = 0;
  let last: { id: number; hash: string } | null = null;
  if (options.fromId === undefined) expectedPrev = null;

  for (;;) {
    const rows = await db.select().from(auditLog).where(gte(auditLog.id, cursor)).orderBy(asc(auditLog.id)).limit(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (expectedPrev !== undefined && row.prevHash !== expectedPrev) {
        return { ok: false, checked, brokenAt: row.id, reason: "broken_link", expected: expectedPrev ?? "null", found: row.prevHash };
      }
      const recomputed = computeAuditHash(row.prevHash, { caseId: row.caseId, at: row.at, actor: row.actor, kind: row.kind, data: row.data });
      if (recomputed !== row.hash) {
        return { ok: false, checked, brokenAt: row.id, reason: "hash_mismatch", expected: recomputed, found: row.hash };
      }
      expectedPrev = row.hash;
      last = { id: row.id, hash: row.hash };
      checked++;
    }
    cursor = rows[rows.length - 1]!.id + 1;
  }
  return { ok: true, checked, lastId: last?.id ?? null, lastHash: last?.hash ?? null };
}

/** Audit entries for one case, oldest first. */
export async function caseTrail(db: Database, caseId: string) {
  return db.select().from(auditLog).where(sql`${auditLog.caseId} = ${caseId}`).orderBy(asc(auditLog.id));
}
