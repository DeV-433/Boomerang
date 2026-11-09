import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuditListResponse, CaseAuditResponse } from "@boomerang/core";
import { escalateCase, setCasePaused } from "@boomerang/cases";
import { cases, customers, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import type { WebhookVerifier } from "@boomerang/paypal";
import { buildApp } from "../src/app";

const verifier: WebhookVerifier = { verify: async () => ({ verified: true }) };
const TOKEN = "audit-test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

describe.skipIf(!hasTestDb)("dashboard API: audit (6.7)", () => {
  let h: DbHandle;
  let app: FastifyInstance;
  let caseId: string;
  let ref: string;
  const get = async <T>(url: string) => {
    const res = await app.inject({ method: "GET", url, headers: auth });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<T>();
  };

  beforeAll(async () => {
    h = await setupTestDb();
    app = await buildApp({ db: h, verifier, operatorToken: TOKEN });
    const [cust] = await h.db
      .insert(customers)
      .values({ email: "audit@example.com", simulated: true })
      .returning();
    ref = `AUDIT-${randomUUID()}`;
    const [c] = await h.db
      .insert(cases)
      .values({
        lane: "invoice",
        paypalRef: ref,
        customerId: cust!.id,
        amountCents: 5_000,
        currency: "USD",
        state: "awaiting",
        simulated: true,
      })
      .returning();
    caseId = c!.id;
    await setCasePaused(h.db, caseId, true, "operator", "first");
    await setCasePaused(h.db, caseId, false, "operator", "second");
    await escalateCase(h.db, caseId, "operator", "third");
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("returns a case's trail in the order it was written", async () => {
    const trail = await get<CaseAuditResponse>(`/api/cases/${caseId}/audit`);
    expect(trail).toMatchObject({ caseId, paypalRef: ref, state: "escalated" });
    expect(trail.entries.map((e) => e.kind)).toEqual(["system", "system", "closed"]);
    expect(trail.entries.map((e) => e.data.note ?? e.data.reason)).toEqual([
      "first",
      "second",
      "escalated by operator: third",
    ]);
    const ids = trail.entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(trail.entries.every((e) => e.hash.length > 0 && e.prevHash !== undefined)).toBe(true);
  });

  it("lists, filters and searches the whole log, newest first", async () => {
    const byCase = await get<AuditListResponse>(`/api/audit?case=${caseId}`);
    expect(byCase.total).toBe(3);
    expect(byCase.rows[0]).toMatchObject({ kind: "closed", paypalRef: ref, caseState: "escalated" });
    const closedOnly = await get<AuditListResponse>(`/api/audit?case=${caseId}&kind=closed`);
    expect(closedOnly.rows.map((r) => r.kind)).toEqual(["closed"]);
    const searched = await get<AuditListResponse>(`/api/audit?q=${encodeURIComponent(ref)}`);
    expect(searched.total).toBe(3);
    const inData = await get<AuditListResponse>(
      `/api/audit?q=${encodeURIComponent("escalated by operator: third")}&case=${caseId}`,
    );
    expect(inData.total).toBe(1);
    const page = await get<AuditListResponse>(`/api/audit?limit=2&offset=0`);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]!.id).toBeGreaterThan(page.rows[1]!.id);
  });

  it("rejects bad input and unknown cases, and requires the token", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/audit?kind=deleted", headers: auth })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/cases/nope/audit", headers: auth })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `/api/cases/${randomUUID()}/audit`, headers: auth }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/audit" })).statusCode).toBe(401);
  });
});
