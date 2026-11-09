import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SummaryResponse } from "@boomerang/core";
import { batches, cases, customers, simRuns, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import type { WebhookVerifier } from "@boomerang/paypal";
import { buildApp } from "../src/app";

const verifier: WebhookVerifier = { verify: async () => ({ verified: true }) };
const TOKEN = "operator-test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

describe.skipIf(!hasTestDb)("dashboard API: operator token and summary (6.2)", () => {
  let h: DbHandle;
  let app: FastifyInstance;
  let closed: FastifyInstance;
  let batchId: string;

  beforeAll(async () => {
    h = await setupTestDb();
    app = await buildApp({
      db: h,
      verifier,
      operatorToken: TOKEN,
      policyMode: "dry_run",
      corsOrigins: ["https://dash.example"],
    });
    closed = await buildApp({ db: h, verifier });

    const [batch] = await h.db
      .insert(batches)
      .values({ name: "summary", seed: `summary-${randomUUID()}`, size: 4, mode: "offline", simConfig: {} })
      .returning();
    batchId = batch!.id;
    const [cust] = await h.db
      .insert(customers)
      .values({ email: "s@example.com", simulated: true })
      .returning();
    const mk = (arm: "control" | "treatment", amountCents: number, recoveredCents: number) => ({
      lane: "invoice" as const,
      paypalRef: `SUM-${randomUUID()}`,
      customerId: cust!.id,
      amountCents,
      currency: "USD",
      recoveredCents,
      state: recoveredCents > 0 ? ("recovered" as const) : ("awaiting" as const),
      batchId,
      experimentGroup: arm,
      simulated: true,
    });
    await h.db
      .insert(cases)
      .values([
        mk("control", 10_000, 10_000),
        mk("control", 30_000, 0),
        mk("treatment", 20_000, 20_000),
        mk("treatment", 20_000, 0),
      ]);

    const metrics = (rate: number, atRisk: number) => ({
      cases: 2,
      atRiskCents: atRisk,
      recoveredCents: Math.round(rate * atRisk),
      recoveredCases: 1,
      recoveryRate: rate,
      contacts: 3,
      contactsPerRecoveredDollar: 0.01,
      medianDaysToRecovery: 4,
      disputes: 0,
      optOuts: 0,
      contactsAfterOptOut: 0,
    });
    await h.db.insert(simRuns).values([
      {
        batchId,
        arm: "control",
        strategy: "baseline-fixed-schedule",
        seed: "s",
        simConfig: {},
        metrics: metrics(0.6, 40_000),
        finishedAt: new Date(),
      },
      {
        batchId,
        arm: "treatment",
        strategy: "boomerang-rules",
        seed: "s",
        simConfig: {},
        metrics: metrics(0.5, 40_000),
        finishedAt: new Date(),
      },
      {
        batchId,
        arm: "treatment",
        strategy: "boomerang-agent",
        seed: "s",
        simConfig: {},
        metrics: metrics(0.55, 40_000),
        finishedAt: new Date(),
      },
      { batchId, arm: "treatment", strategy: "boomerang-rules", seed: "s", simConfig: {}, metrics: null }, // unfinished: ignored
    ]);
  });
  afterAll(async () => {
    await app?.close();
    await closed?.close();
    await h?.close();
  });

  it("rejects /api calls without the right token, and stays closed when no token is configured", async () => {
    expect((await app.inject({ method: "GET", url: "/api/summary" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/summary", headers: { authorization: "Bearer wrong" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/summary", headers: { authorization: TOKEN } }))
        .statusCode,
    ).toBe(401);
    expect((await closed.inject({ method: "GET", url: "/api/summary", headers: auth })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("answers CORS preflight for the dashboard origin only", async () => {
    const pre = (origin: string) =>
      app.inject({
        method: "OPTIONS",
        url: "/api/summary",
        headers: {
          origin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      });
    expect((await pre("https://dash.example")).headers["access-control-allow-origin"]).toBe(
      "https://dash.example",
    );
    expect((await pre("https://evil.example")).headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("returns live at-risk, recovered, rate and the control comparison for a batch", async () => {
    const res = await app.inject({ method: "GET", url: `/api/summary?batch=${batchId}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const s = res.json<SummaryResponse>();
    expect(s.batch?.id).toBe(batchId);
    expect(s.live.control).toEqual({
      cases: 2,
      atRiskCents: 40_000,
      recoveredCents: 10_000,
      recoveredCases: 1,
      recoveryRate: 0.25,
    });
    expect(s.live.treatment).toEqual({
      cases: 2,
      atRiskCents: 40_000,
      recoveredCents: 20_000,
      recoveredCases: 1,
      recoveryRate: 0.5,
    });
    expect(s.live.upliftPoints).toBeCloseTo(25);
    expect(s.system).toEqual({ paused: expect.any(Boolean), mode: "dry_run" });
  });

  it("compares the latest simulated control run with the agent run by default, or a chosen run", async () => {
    const s = (
      await app.inject({ method: "GET", url: `/api/summary?batch=${batchId}`, headers: auth })
    ).json<SummaryResponse>();
    expect(s.simulated.control?.strategy).toBe("baseline-fixed-schedule");
    expect(s.simulated.treatment?.strategy).toBe("boomerang-agent");
    expect(s.simulated.upliftPoints).toBeCloseTo(-5);
    expect(s.simulated.runs).toHaveLength(3);
    const rules = s.simulated.runs.find((r) => r.strategy === "boomerang-rules")!;
    const chosen = (
      await app.inject({
        method: "GET",
        url: `/api/summary?batch=${batchId}&treatmentRun=${rules.id}`,
        headers: auth,
      })
    ).json<SummaryResponse>();
    expect(chosen.simulated.treatment?.id).toBe(rules.id);
    expect(chosen.simulated.upliftPoints).toBeCloseTo(-10);
  });

  it("validates its query", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/summary?batch=nope", headers: auth })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `/api/summary?batch=${randomUUID()}`, headers: auth }))
        .statusCode,
    ).toBe(404);
  });
});
