import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { AUDIT_CHAIN_LOCK, auditLog, computeAuditHash, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb, testDatabaseUrl } from "@boomerang/db/testing";
import { tamperDemo } from "../src/tamper";
import { LEGACY_DATE_HASH_BEFORE, verifyChain } from "../src/verify";
import { writeAudit } from "../src/writer";

describe.skipIf(!hasTestDb)("hash-chained audit writer (4.2)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await setupTestDb();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("links every entry to the previous hash, and a chain of 100 entries verifies", async () => {
    const first = await writeAudit(h.db, {
      caseId: null,
      actor: "test",
      kind: "system",
      data: { n: 0, nested: { b: 2, a: 1 } },
    });
    for (let n = 1; n < 100; n++) {
      await writeAudit(h.db, { caseId: null, actor: "test", kind: "system", data: { n } });
    }
    const verdict = await verifyChain(h.db, { fromId: first.id });
    expect(verdict.ok).toBe(true);
    expect(verdict.checked).toBeGreaterThanOrEqual(100);
  });

  it("keeps the chain intact under concurrent writers", async () => {
    const first = await writeAudit(h.db, {
      caseId: null,
      actor: "test",
      kind: "system",
      data: { start: true },
    });
    await Promise.all(
      Array.from({ length: 30 }, (_, n) =>
        writeAudit(h.db, { caseId: null, actor: `w${n % 3}`, kind: "system", data: { n } }),
      ),
    );
    expect((await verifyChain(h.db, { fromId: first.id })).ok).toBe(true);
  });

  it("rejects an unknown entry kind", async () => {
    // @ts-expect-error not an audit kind
    await expect(writeAudit(h.db, { caseId: null, actor: "t", kind: "made_up", data: {} })).rejects.toThrow(
      /unknown audit kind/,
    );
  });

  it("detects an edited entry at the right position (in a throwaway copy of the table)", async () => {
    const first = await writeAudit(h.db, { caseId: null, actor: "test", kind: "system", data: { seq: 1 } });
    const target = await writeAudit(h.db, {
      caseId: null,
      actor: "test",
      kind: "system",
      data: { amount: 100 },
    });
    await writeAudit(h.db, { caseId: null, actor: "test", kind: "system", data: { seq: 3 } });

    // The real table refuses edits, so tamper with a copy in a temporary schema, as the 7B.3 demo will.
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      const schema = `tamper_${Date.now()}`;
      await client.query(`create schema ${schema}`);
      await client.query(
        `create table ${schema}.audit_log as select * from public.audit_log where id >= $1`.replace(
          "$1",
          String(first.id),
        ),
      );
      await client.query(`update ${schema}.audit_log set data = '{"amount": 1}' where id = ${target.id}`);
      await client.query(`set search_path to ${schema}`);
      const copy = drizzle(client) as unknown as typeof h.db;
      const verdict = await verifyChain(copy, { fromId: first.id });
      expect(verdict).toMatchObject({ ok: false, brokenAt: target.id, reason: "hash_mismatch" });
      await client.query(`set search_path to public`);
      await client.query(`drop schema ${schema} cascade`);
    } finally {
      await client.end();
    }
    void auditLog;
  });

  // 7B.1: a Date inside `data` used to hash as {} while jsonb stored its ISO string.
  it("hashes a Date in the data as its ISO string, so the stored entry verifies as written", async () => {
    const first = await writeAudit(h.db, {
      caseId: null,
      actor: "test",
      kind: "scheduled",
      data: { runAt: new Date("2026-12-01T09:30:00.000Z"), nested: [{ at: new Date(0) }] },
    });
    const v = await verifyChain(h.db, { fromId: first.id });
    expect(v).toMatchObject({ ok: true, legacyDateEntries: [] });
  });

  it("accepts an entry hashed the old way only before the cutoff, and lists it", async () => {
    const legacyAt = new Date(LEGACY_DATE_HASH_BEFORE.getTime() - 3_600_000);
    const lateAt = new Date(LEGACY_DATE_HASH_BEFORE.getTime() + 3_600_000);
    const insertOldStyle = async (at: Date) =>
      h.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);
        const prev =
          (await tx.execute<{ hash: string }>(sql`select hash from audit_log order by id desc limit 1`))
            .rows[0]?.hash ?? null;
        const stored = { effect: { kind: "retry_at", at: "2026-11-09T15:00:00.000Z" } };
        // The old hasher saw the Date as {}: reproduce that hash, store the ISO string.
        const hash = computeAuditHash(prev, {
          caseId: null,
          at,
          actor: "gate",
          kind: "gated",
          data: { effect: { kind: "retry_at", at: {} } },
        });
        const [row] = await tx
          .insert(auditLog)
          .values({ caseId: null, at, actor: "gate", kind: "gated", data: stored, prevHash: prev, hash })
          .returning({ id: auditLog.id });
        return row!.id;
      });
    const legacyId = await insertOldStyle(legacyAt);
    expect(await verifyChain(h.db, { fromId: legacyId })).toMatchObject({
      ok: true,
      legacyDateEntries: [legacyId],
    });

    // The same thing dated after the cutoff is a real mismatch.
    const lateId = await insertOldStyle(lateAt);
    expect(await verifyChain(h.db, { fromId: lateId })).toMatchObject({
      ok: false,
      brokenAt: lateId,
      reason: "hash_mismatch",
    });
  });

  // 7B.3
  it("tamper demo: catches the edit at the edited entry, rolls back, and leaves the real log intact", async () => {
    const first = await writeAudit(h.db, {
      caseId: null,
      actor: "executor",
      kind: "executed",
      data: { tool: "send_invoice_reminder", subject: "Reminder: invoice X for $40.00" },
    });
    await writeAudit(h.db, { caseId: null, actor: "test", kind: "system", data: { after: true } });
    const r = await tamperDemo(h, { entryId: first.id, fromId: first.id });
    expect(r.edited).toMatchObject({ id: first.id, change: "changed the recorded message subject" });
    expect(r.copy).toMatchObject({ ok: false, brokenAt: first.id, reason: "hash_mismatch" });
    expect(r.real).toMatchObject({ ok: true });
    const schema = await h.db.execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.schemata where schema_name = 'tamper_demo'`,
    );
    expect(schema.rows[0]!.n).toBe(0); // the copy never outlived its transaction
  });
});
