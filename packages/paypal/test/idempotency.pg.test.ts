import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paypalCalls, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import { IdempotencyConflictError, IdempotencyInFlightError, PgIdempotencyStore } from "../src/idempotency";

describe.skipIf(!hasTestDb)("PgIdempotencyStore (2.5)", () => {
  let h: DbHandle;
  let store: PgIdempotencyStore;
  const claim = (key: string, tool = "send_invoice_reminder") =>
    store.claim({ key, tool, profile: "invoice", request: { invoice_id: "INV2-X" } });

  beforeAll(async () => {
    h = await setupTestDb();
    store = new PgIdempotencyStore(h.db);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("returns the stored response once a key has succeeded", async () => {
    const key = randomUUID();
    expect(await claim(key)).toEqual({ kind: "claimed", attempt: 1 });
    await store.complete(key, { ok: true });
    expect(await claim(key)).toEqual({ kind: "done", response: { ok: true } });
  });

  it("lets exactly one of many concurrent callers claim a key", async () => {
    const key = randomUUID();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => claim(key)));
    const claimed = results.filter((r) => r.status === "fulfilled" && r.value.kind === "claimed");
    expect(claimed).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(9);
    for (const r of rejected)
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(IdempotencyInFlightError);
  });

  it("allows a failed call to be retaken and counts the attempts", async () => {
    const key = randomUUID();
    await claim(key);
    await store.fail(key, new Error("boom"));
    expect(await claim(key)).toEqual({ kind: "claimed", attempt: 2 });
  });

  it("retakes a pending claim only after its lease has expired", async () => {
    const key = randomUUID();
    await claim(key);
    await expect(claim(key)).rejects.toThrow(IdempotencyInFlightError);
    await h.db
      .update(paypalCalls)
      .set({ claimedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(paypalCalls.idempotencyKey, key));
    expect(await claim(key)).toEqual({ kind: "claimed", attempt: 2 });
  });

  it("refuses to reuse a key for a different operation", async () => {
    const key = randomUUID();
    await claim(key, "send_invoice_reminder");
    await store.complete(key, {});
    await expect(claim(key, "record_payment_for_invoice")).rejects.toThrow(IdempotencyConflictError);
  });
});
