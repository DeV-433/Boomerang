import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { auditLog } from "./schema";

/** Serializes appends so each entry links to the true previous one, across processes. */
export const AUDIT_CHAIN_LOCK = 727_002;

/** JSON with object keys sorted at every level, so jsonb's key reordering never changes a hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export interface AuditFields {
  caseId: string | null;
  at: Date;
  actor: string;
  kind: string;
  data: unknown;
}

/** sha256 over the previous hash and the entry's content. Changing either breaks every later link. */
export function computeAuditHash(prevHash: string | null, entry: AuditFields): string {
  const content = canonicalJson({
    prev: prevHash,
    caseId: entry.caseId,
    at: entry.at.toISOString(),
    actor: entry.actor,
    kind: entry.kind,
    data: entry.data,
  });
  return createHash("sha256").update(content).digest("hex");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = NodePgDatabase<any>;

/**
 * Appends one hash-chained entry. Must run inside a transaction: the advisory lock is held until
 * commit, so concurrent writers queue instead of both linking to the same previous entry.
 */
export async function appendAuditEntry(
  tx: AnyDb,
  entry: Omit<AuditFields, "at"> & { at?: Date },
): Promise<{ id: number; hash: string; prevHash: string | null }> {
  await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);
  const last = await tx.execute<{ hash: string }>(sql`select hash from audit_log order by id desc limit 1`);
  const prevHash = last.rows[0]?.hash ?? null;
  // Millisecond precision, because that is what survives the round trip through timestamptz and Date.
  const at = new Date(Math.floor((entry.at ?? new Date()).getTime()));
  const full = { ...entry, at };
  const hash = computeAuditHash(prevHash, full);
  const [row] = await tx
    .insert(auditLog)
    .values({ caseId: entry.caseId, at, actor: entry.actor, kind: entry.kind, data: entry.data ?? {}, prevHash, hash })
    .returning({ id: auditLog.id });
  return { id: row!.id, hash, prevHash };
}
