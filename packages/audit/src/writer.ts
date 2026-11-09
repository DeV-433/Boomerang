import { sql } from "drizzle-orm";
import { appendAuditEntry, AUDIT_CHAIN_LOCK, type Database } from "@boomerang/db";

/** Entry kinds from section 10 of the project documentation. */
export const AUDIT_KINDS = [
  "event_received",
  "diagnosed",
  "proposed",
  "gated",
  "approval",
  "executed",
  "observed",
  "closed",
  "scheduled",
  "system",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditInput {
  caseId: string | null;
  /** Who acted: "rules", "agent:<model>", "gate", "executor", "worker", "operator:<id>", "paypal". */
  actor: string;
  kind: AuditKind;
  data: Record<string, unknown>;
  at?: Date;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Step 4.2: writes hash-chained audit entries. Pure code: this package may never import the model
 * SDK or PayPal (enforced by lint). Pass a transaction so the entry commits with the change it records.
 */
export async function writeAudit(tx: Tx | Database, input: AuditInput): Promise<{ id: number; hash: string }> {
  if (!(AUDIT_KINDS as readonly string[]).includes(input.kind)) throw new Error(`unknown audit kind: ${input.kind}`);
  const run = (t: Tx | Database) => appendAuditEntry(t, input);
  // appendAuditEntry needs a transaction for its advisory lock; open one if the caller did not.
  return "transaction" in tx && typeof (tx as Database).transaction === "function" && !("rollback" in tx)
    ? (tx as Database).transaction(run)
    : run(tx);
}

/**
 * A transaction that takes the audit-chain lock before anything else. Every transaction that both
 * locks rows and writes audit entries must use this: taking the chain lock first gives all of them
 * one lock order, so a case-row lock and the chain lock can never deadlock against each other.
 */
export async function auditedTransaction<T>(db: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);
    return fn(tx);
  });
}
