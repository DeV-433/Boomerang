import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { appendAuditEntry } from "../src/audit-chain";
import { actions, approvals, auditLog, cases, customers, events } from "../src/schema";
import { hasTestDb, setupTestDb } from "../src/testing";
import type { DbHandle } from "../src/client";

/** Postgres error codes we assert on. */
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
const INSUFFICIENT_PRIVILEGE = "42501";

async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
  }
}

describe.skipIf(!hasTestDb)("database schema", () => {
  let h: DbHandle;

  beforeAll(async () => {
    h = await setupTestDb();
  });
  afterAll(async () => {
    await h?.close();
  });

  async function makeCase() {
    const [customer] = await h.db.insert(customers).values({ email: "c@example.com", simulated: true }).returning();
    const [kase] = await h.db
      .insert(cases)
      .values({
        lane: "invoice",
        paypalRef: `INV2-${randomUUID()}`,
        customerId: customer!.id,
        amountCents: 12_500,
        currency: "USD",
        simulated: true,
      })
      .returning();
    return kase!;
  }

  // 1.4
  it("rejects a second event with the same paypal_event_id", async () => {
    const paypalEventId = `WH-${randomUUID()}`;
    const row = { paypalEventId, type: "INVOICING.INVOICE.PAID", payload: {}, rawBody: "{}", headers: {} };
    await h.db.insert(events).values(row);
    expect(await pgErrorCode(h.db.insert(events).values(row))).toBe(UNIQUE_VIOLATION);
  });

  it("allows only one open case per PayPal object", async () => {
    const kase = await makeCase();
    const duplicate = { ...kase, id: undefined, openedAt: undefined, updatedAt: undefined };
    expect(await pgErrorCode(h.db.insert(cases).values(duplicate))).toBe(UNIQUE_VIOLATION);

    // Once the first case is closed, a new linked case may be opened.
    await h.db.update(cases).set({ state: "recovered", closedAt: new Date() }).where(eq(cases.id, kase.id));
    await h.db.insert(cases).values({ ...duplicate, parentCaseId: kase.id });
  });

  // 1.5
  it("links actions and approvals to cases through foreign keys", async () => {
    const kase = await makeCase();
    const [action] = await h.db
      .insert(actions)
      .values({ caseId: kase.id, action: "send_reminder", proposedBy: "rules" })
      .returning();
    const [approval] = await h.db.insert(approvals).values({ actionId: action!.id }).returning();
    expect(approval!.status).toBe("pending");

    const orphan = h.db.insert(actions).values({ caseId: randomUUID(), action: "send_reminder", proposedBy: "rules" });
    expect(await pgErrorCode(orphan)).toBe(FK_VIOLATION);
    expect(await pgErrorCode(h.db.insert(approvals).values({ actionId: randomUUID() }))).toBe(FK_VIOLATION);
  });

  // 1.6
  describe("audit_log", () => {
    // Entries go through the chain primitive so the shared test database keeps a valid hash chain.
    async function insertEntry() {
      const { id } = await h.db.transaction((tx) =>
        appendAuditEntry(tx, { caseId: null, actor: "test", kind: "event_received", data: { n: 1 } }),
      );
      const [entry] = await h.db.select().from(auditLog).where(eq(auditLog.id, id));
      return entry!;
    }

    it("rejects update and delete for the application role, but allows insert and select", async () => {
      const entry = await insertEntry();
      const client = await h.pool.connect();
      try {
        await client.query("begin");
        await client.query("set local role boomerang_app");
        await appendAuditEntry(drizzle(client), { caseId: null, actor: "app", kind: "test", data: {} });
        await client.query("commit");
        await client.query("set role boomerang_app");
        const { rowCount } = await client.query("select 1 from audit_log where id = $1", [entry.id]);
        expect(rowCount).toBe(1);
        expect(await pgErrorCode(client.query("update audit_log set actor = 'x' where id = $1", [entry.id]))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect(await pgErrorCode(client.query("delete from audit_log where id = $1", [entry.id]))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      } finally {
        await client.query("reset role");
        client.release();
      }
    });

    it("rejects update, delete and truncate even for the table owner", async () => {
      const entry = await insertEntry();
      const q = (sql: string) => pgErrorCode(h.pool.query(sql, sql.includes("$1") ? [entry.id] : []));
      expect(await q("update audit_log set actor = 'x' where id = $1")).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await q("delete from audit_log where id = $1")).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await q("truncate audit_log")).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });
});
