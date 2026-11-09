import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CaseGroupsResponse, CasesResponse } from "@boomerang/core";
import { batches, cases, customers, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import type { WebhookVerifier } from "@boomerang/paypal";
import { buildApp } from "../src/app";

const verifier: WebhookVerifier = { verify: async () => ({ verified: true }) };
const TOKEN = "cases-test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const STATES = ["awaiting", "recovered", "approval", "escalated", "stopped"] as const;
const CAUSES = ["overdue_no_engagement", "overdue_unresponsive", "expired_funding_source", null] as const;

describe.skipIf(!hasTestDb)("dashboard API: cases (6.4, 6.6)", () => {
  let h: DbHandle;
  let app: FastifyInstance;
  let batchId: string;
  const get = async <T>(url: string) => {
    const res = await app.inject({ method: "GET", url, headers: auth });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<T>();
  };

  beforeAll(async () => {
    h = await setupTestDb();
    app = await buildApp({ db: h, verifier, operatorToken: TOKEN });
    const [batch] = await h.db
      .insert(batches)
      .values({ name: "cases", seed: `cases-${randomUUID()}`, size: 300, mode: "offline", simConfig: {} })
      .returning();
    batchId = batch!.id;
    const custs = await h.db
      .insert(customers)
      .values(
        Array.from({ length: 300 }, (_, i) => ({
          email: `buyer${i}@example.com`,
          name: i === 7 ? "Needle Findable" : null,
          simulated: true,
        })),
      )
      .returning();
    await h.db.insert(cases).values(
      custs.map((c, i) => {
        const state = STATES[i % STATES.length]!;
        return {
          lane: i % 3 === 0 ? ("subscription" as const) : ("invoice" as const),
          paypalRef: `CASES-${i}-${randomUUID()}`,
          customerId: c.id,
          amountCents: 1_000 + ((i * 7919) % 50_000),
          currency: "USD",
          cause: CAUSES[i % CAUSES.length] ?? null,
          state,
          stage: i % 4,
          recoveredCents: state === "recovered" ? 500 : 0,
          batchId,
          experimentGroup: i % 2 === 0 ? ("control" as const) : ("treatment" as const),
          simulated: true,
          closedAt: ["recovered", "escalated", "stopped"].includes(state) ? new Date() : null,
        };
      }),
    );
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("pages through 300 cases on the server with no overlap or gap", async () => {
    const seen = new Set<string>();
    for (let offset = 0; offset < 300; offset += 50) {
      const page = await get<CasesResponse>(
        `/api/cases?batch=${batchId}&offset=${offset}&limit=50&sort=amountCents&dir=desc`,
      );
      expect(page.total).toBe(300);
      expect(page.rows).toHaveLength(50);
      for (const r of page.rows) seen.add(r.id);
    }
    expect(seen.size).toBe(300);
    const beyond = await get<CasesResponse>(`/api/cases?batch=${batchId}&offset=300&limit=50`);
    expect(beyond.rows).toHaveLength(0);
  });

  it("sorts on the server, across pages", async () => {
    const first = await get<CasesResponse>(`/api/cases?batch=${batchId}&limit=100&sort=amountCents&dir=desc`);
    const second = await get<CasesResponse>(
      `/api/cases?batch=${batchId}&offset=100&limit=100&sort=amountCents&dir=desc`,
    );
    const amounts = [...first.rows, ...second.rows].map((r) => r.amountCents);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    const asc = await get<CasesResponse>(`/api/cases?batch=${batchId}&limit=300&sort=stage&dir=asc`);
    expect(asc.rows.map((r) => r.stage)).toEqual([...asc.rows.map((r) => r.stage)].sort((a, b) => a - b));
  });

  it("filters by lane, state, cause (including none), arm, open and search text", async () => {
    const subs = await get<CasesResponse>(`/api/cases?batch=${batchId}&lane=subscription&limit=500`);
    expect(subs.total).toBe(100);
    expect(subs.rows.every((r) => r.lane === "subscription")).toBe(true);
    const twoStates = await get<CasesResponse>(`/api/cases?batch=${batchId}&state=recovered,escalated`);
    expect(twoStates.total).toBe(120);
    const noCause = await get<CasesResponse>(`/api/cases?batch=${batchId}&cause=none`);
    expect(noCause.total).toBe(75);
    const control = await get<CasesResponse>(`/api/cases?batch=${batchId}&arm=control&open=true`);
    expect(control.rows.every((r) => r.arm === "control" && r.closedAt === null)).toBe(true);
    const needle = await get<CasesResponse>(`/api/cases?batch=${batchId}&q=needle`);
    expect(needle.total).toBe(1);
    expect(needle.rows[0]!.customer).toBe("Needle Findable");
    const pct = await get<CasesResponse>(`/api/cases?batch=${batchId}&q=${encodeURIComponent("%")}`);
    expect(pct.total).toBe(0); // LIKE wildcards in the search are taken literally
  });

  it("returns group totals that match the cases they summarise", async () => {
    const all = await get<CasesResponse>(`/api/cases?batch=${batchId}&limit=500`);
    for (const by of ["cause", "state", "lane", "arm"] as const) {
      const g = await get<CaseGroupsResponse>(`/api/cases/groups?batch=${batchId}&by=${by}`);
      const field = { cause: "cause", state: "state", lane: "lane", arm: "arm" }[by] as
        "cause" | "state" | "lane" | "arm";
      for (const group of g.groups) {
        const members = all.rows.filter((r) => r[field] === group.key);
        expect(group.cases).toBe(members.length);
        expect(group.amountCents).toBe(members.reduce((s, r) => s + r.amountCents, 0));
        expect(group.recoveredCents).toBe(members.reduce((s, r) => s + r.recoveredCents, 0));
      }
      expect(g.groups.reduce((s, x) => s + x.cases, 0)).toBe(300);
    }
  });

  it("rejects bad queries and requires the token", async () => {
    for (const q of [
      "sort=password",
      "dir=up",
      "limit=0",
      "limit=10000",
      "state=nope",
      "lane=crypto",
      "batch=x",
    ]) {
      expect((await app.inject({ method: "GET", url: `/api/cases?${q}`, headers: auth })).statusCode, q).toBe(
        400,
      );
    }
    expect(
      (await app.inject({ method: "GET", url: "/api/cases/groups?by=email", headers: auth })).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/cases" })).statusCode).toBe(401);
  });
});
