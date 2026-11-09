import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { auditLog, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb, testDatabaseUrl } from "@boomerang/db/testing";
import { verifyChain } from "../src/verify";
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
    const first = await writeAudit(h.db, { caseId: null, actor: "test", kind: "system", data: { n: 0, nested: { b: 2, a: 1 } } });
    for (let n = 1; n < 100; n++) {
      await writeAudit(h.db, { caseId: null, actor: "test", kind: "system", data: { n } });
    }
    const verdict = await verifyChain(h.db, { fromId: first.id });
    expect(verdict.ok).toBe(true);
    expect(verdict.checked).toBeGreaterThanOrEqual(100);
  });

  it("keeps the chain intact under concurrent writers", async () => {
    const first = await writeAudit(h.db, { caseId: null, actor: "test", kind: "system", data: { start: true } });
    await Promise.all(Array.from({ length: 30 }, (_, n) => writeAudit(h.db, { caseId: null, actor: `w${n % 3}`, kind: "system", data: { n } })));
    expect((await verifyChain(h.db, { fromId: first.id })).ok).toBe(true);
  });

  it("rejects an unknown entry kind", async () => {
    // @ts-expect-error not an audit kind
    await expect(writeAudit(h.db, { caseId: null, actor: "t", kind: "made_up", data: {} })).rejects.toThrow(/unknown audit kind/);
  });

  it("detects an edited entry at the right position (in a throwaway copy of the table)", async () => {
    const first = await writeAudit(h.db, { caseId: null, actor: "test", kind: "system", data: { seq: 1 } });
    const target = await writeAudit(h.db, { caseId: null, actor: "test", kind: "system", data: { amount: 100 } });
    await writeAudit(h.db, { caseId: null, actor: "test", kind: "system", data: { seq: 3 } });

    // The real table refuses edits, so tamper with a copy in a temporary schema, as the 7B.3 demo will.
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      const schema = `tamper_${Date.now()}`;
      await client.query(`create schema ${schema}`);
      await client.query(`create table ${schema}.audit_log as select * from public.audit_log where id >= $1`.replace("$1", String(first.id)));
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
});
