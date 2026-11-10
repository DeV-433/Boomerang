import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "@boomerang/api";
import { cases, events, simProfiles, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import { baselineStrategy } from "../src/baseline";
import { loadSimConfig, parseSimConfig } from "../src/config";
import { simulateArm } from "../src/engine";
import type { EventPoster } from "../src/inject";
import { computeMetrics } from "../src/metrics";
import { Rng } from "../src/rng";
import { seedBatch } from "../src/seed";
import { plannedArms } from "../src/sensitivity";
import { findBatch, loadSimCases, saveRun } from "../src/store";

const SECRET = "seed-test-secret";

describe.skipIf(!hasTestDb)("seeding a batch end to end (3.3 to 3.5, 3.7)", () => {
  let h: DbHandle;
  let app: FastifyInstance;
  let poster: EventPoster;
  const config = loadSimConfig();
  const seed = `test-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    h = await setupTestDb();
    app = await buildApp({
      db: h,
      verifier: { verify: async () => ({ verified: false, reason: "unused" }) },
      simulation: { secret: SECRET },
    });
    // Subscription failures go through the real API route, in process.
    poster = async (rawBody, headers) => {
      const res = await app.inject({ method: "POST", url: "/webhooks/simulated", headers, payload: rawBody });
      return { status: res.statusCode, body: res.body };
    };
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  const seedIt = () =>
    seedBatch({ db: h.db, config, seed, size: 60, mode: "offline", poster, simSecret: SECRET });

  it("creates every case with a hidden profile, opened through the API for subscriptions, split into two arms", async () => {
    const summary = await seedIt();
    expect(summary.invoices + summary.subscriptions).toBe(60);
    expect(summary.subscriptions).toBeGreaterThan(0);
    expect(Math.abs(summary.control - summary.treatment)).toBeLessThanOrEqual(1);

    const rows = await h.db.select().from(cases).where(eq(cases.batchId, summary.batchId));
    expect(rows).toHaveLength(60);
    expect(rows.every((r) => r.experimentGroup === "control" || r.experimentGroup === "treatment")).toBe(
      true,
    );
    expect(
      await h.db.select().from(simProfiles).where(eq(simProfiles.batchId, summary.batchId)),
    ).toHaveLength(60);

    // Every subscription case came from a stored, simulated, processed event.
    const subCases = rows.filter((r) => r.lane === "subscription");
    for (const c of subCases) {
      const [event] = await h.db.select().from(events).where(eq(events.caseId, c.id));
      expect(event).toMatchObject({
        simulated: true,
        source: "simulated",
        type: "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
      });
    }
  });

  it("splits the arms by seed alone: the same split as planning the batch in memory (10.1)", async () => {
    const summary = await seedIt();
    const rows = await h.db
      .select({ arm: cases.experimentGroup, batchIndex: simProfiles.batchIndex })
      .from(cases)
      .innerJoin(simProfiles, eq(simProfiles.caseId, cases.id))
      .where(eq(cases.batchId, summary.batchId));
    const planned = plannedArms(config, seed, 60);
    const plannedArm = new Map([
      ...planned.control.map((c) => [c.profile.batchIndex, "control"] as const),
      ...planned.treatment.map((c) => [c.profile.batchIndex, "treatment"] as const),
    ]);
    expect(rows).toHaveLength(60);
    for (const r of rows) expect(r.arm).toBe(plannedArm.get(r.batchIndex));
  });

  it("is idempotent: seeding the same seed again adds nothing", async () => {
    const again = await seedIt();
    expect(await h.db.select().from(cases).where(eq(cases.batchId, again.batchId))).toHaveLength(60);
  });

  it("runs the baseline over the stored batch, reproducibly, and stores the run", async () => {
    const batch = await findBatch(h.db, (await seedIt()).batchId);
    const simConfig = parseSimConfig(batch.simConfig);
    const control = await loadSimCases(h.db, batch.id, "control");
    const run = () => simulateArm(simConfig, new Rng(batch.seed), control, baselineStrategy(simConfig));
    const results = await run();
    expect(JSON.stringify(await run())).toBe(JSON.stringify(results));
    const metrics = computeMetrics(results);
    expect(metrics.cases).toBe(control.length);
    expect(metrics.recoveredCents).toBeGreaterThan(0);
    const runId = await saveRun(h.db, {
      batchId: batch.id,
      arm: "control",
      strategy: "baseline",
      seed: batch.seed,
      config: simConfig,
      results,
      metrics,
    });
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
