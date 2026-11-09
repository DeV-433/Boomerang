import { drizzle } from "drizzle-orm/node-postgres";
import type { Database, DbHandle } from "@boomerang/db";
import { verifyChain, type ChainVerdict } from "./verify";

export interface TamperDemoResult {
  /** The entry that was edited in the copy, and how. */
  edited: { id: number; kind: string; actor: string; change: string };
  /** Verification of the edited copy: must fail at `edited.id`. */
  copy: ChainVerdict;
  /** Verification of the real log afterwards: untouched. */
  real: ChainVerdict;
  rolledBack: true;
}

const SCHEMA = "tamper_demo";

/**
 * Step 7B.3: the tamper demo, made safe by a transaction. On one dedicated connection it copies the
 * whole audit log into a scratch schema, edits one entry in the copy the way a dishonest insider
 * might, verifies the copy (which must fail at that entry), then rolls everything back: the schema
 * and the copy never exist outside the transaction, and the real table is only ever read. (It could
 * not be edited anyway: a trigger rejects UPDATE and DELETE on audit_log.)
 *
 * The default target is the newest `executed` entry (a real PayPal send), so the demo shows a
 * forged record of what was sent being caught.
 */
export async function tamperDemo(
  handle: Pick<DbHandle, "pool" | "db">,
  /** `fromId`: verify from this entry on (tests on a shared database); default the whole log. */
  options: { entryId?: number; fromId?: number } = {},
): Promise<TamperDemoResult> {
  const client = await handle.pool.connect();
  let edited: TamperDemoResult["edited"] | undefined;
  let copy: ChainVerdict | undefined;
  try {
    await client.query("begin");
    await client.query(`create schema ${SCHEMA}`);
    await client.query(`create table ${SCHEMA}.audit_log as select * from public.audit_log`);
    const target = options.entryId
      ? await client.query(`select id, kind, actor, data from ${SCHEMA}.audit_log where id = $1`, [
          options.entryId,
        ])
      : await client.query(
          `select id, kind, actor, data from ${SCHEMA}.audit_log order by (kind = 'executed') desc, id desc limit 1`,
        );
    const row = target.rows[0] as
      { id: string | number; kind: string; actor: string; data: Record<string, unknown> } | undefined;
    if (!row)
      throw new Error(
        options.entryId ? `audit entry ${options.entryId} not found` : "the audit log is empty",
      );
    const id = Number(row.id);

    // A plausible forgery: claim a different message was sent, or (for other entries) slip in a field.
    const hasSubject = typeof row.data.subject === "string";
    const patch = hasSubject
      ? { subject: `${String(row.data.subject)} (edited)` }
      : { note: "changed after the fact" };
    await client.query(`update ${SCHEMA}.audit_log set data = data || $1::jsonb where id = $2`, [
      JSON.stringify(patch),
      id,
    ]);
    edited = {
      id,
      kind: row.kind,
      actor: row.actor,
      change: hasSubject ? "changed the recorded message subject" : "added a field to the recorded data",
    };

    // Point this session at the copy and verify it with the same function the real check uses.
    await client.query(`set local search_path to ${SCHEMA}, public`);
    copy = await verifyChain(drizzle(client) as unknown as Database, { fromId: options.fromId });
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
  const real = await verifyChain(handle.db, { fromId: options.fromId });
  return { edited: edited!, copy: copy!, real, rolledBack: true };
}
