import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SavedScenario, ScenarioReloadResponse, WhatIfDefaults, WhatIfResponse } from "@boomerang/core";
import type { DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import { loadSimConfig, seedBatch, type EventPoster } from "@boomerang/sim";
import { buildApp } from "../src/app";

const TOKEN = "whatif-test-token";
const SECRET = "whatif-sim-secret";
const auth = { authorization: `Bearer ${TOKEN}` };

describe.skipIf(!hasTestDb)("dashboard API: what-if (7A.7)", () => {
  let h: DbHandle;
  let app: FastifyInstance;
  let batchId: string;
  const post = (payload: unknown) =>
    app.inject({ method: "POST", url: "/api/whatif", headers: auth, payload: payload as object });

  beforeAll(async () => {
    h = await setupTestDb();
    app = await buildApp({
      db: h,
      verifier: { verify: async () => ({ verified: false, reason: "unused" }) },
      operatorToken: TOKEN,
      simulation: { secret: SECRET },
    });
    const poster: EventPoster = async (rawBody, headers) => {
      const res = await app.inject({ method: "POST", url: "/webhooks/simulated", headers, payload: rawBody });
      return { status: res.statusCode, body: res.body };
    };
    batchId = (
      await seedBatch({
        db: h.db,
        config: loadSimConfig(),
        seed: `whatif-${randomUUID().slice(0, 8)}`,
        size: 120,
        mode: "offline",
        poster,
        simSecret: SECRET,
      })
    ).batchId;
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("returns the diff with intervals for a changed policy, quickly", async () => {
    const started = Date.now();
    const res = await post({ batch: batchId, overrides: { perCase: 1 } });
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json<WhatIfResponse>();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.batch).toMatchObject({ id: batchId, cases: 120 });
    expect(r.overrides).toEqual({ perCase: 1 });
    expect(r.diff.contacts.delta).toBeLessThan(0);
    expect(r.interval.recoveredCents.low).toBeLessThanOrEqual(r.interval.recoveredCents.high);
    // The second call reuses the cached base replay and gives the same answer.
    const again = (await post({ batch: batchId, overrides: { perCase: 1 } })).json<WhatIfResponse>();
    expect(again.fingerprints).toEqual(r.fingerprints);
    expect(again.diff).toEqual(r.diff);
  });

  it("an empty override is a zero diff, and the defaults describe the current policy", async () => {
    const r = (await post({ batch: batchId })).json<WhatIfResponse>();
    expect(r.diff).toMatchObject({ casesChanged: 0, recoveredCents: { delta: 0 } });
    expect(r.fingerprints.base).toBe(r.fingerprints.scenario);
    const d = (
      await app.inject({ method: "GET", url: "/api/whatif/defaults", headers: auth })
    ).json<WhatIfDefaults>();
    expect(d).toMatchObject({ perCase: 3, minGapHours: 48, hoursStart: 9, hoursEnd: 19 });
  });

  it("validates input and requires the token", async () => {
    expect((await post({ batch: batchId, overrides: { perCase: 0 } })).statusCode).toBe(400);
    expect((await post({ batch: batchId, overrides: { hoursStart: 18, hoursEnd: 9 } })).statusCode).toBe(400);
    expect((await post({ batch: batchId, overrides: { mode: "live" } })).statusCode).toBe(400);
    expect((await post({ batch: randomUUID() })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/whatif", payload: {} })).statusCode).toBe(401);
  });

  it("saves a named scenario that reloads with the same result (7A.9)", async () => {
    const name = `stricter cap ${randomUUID().slice(0, 6)}`;
    const saved = await app.inject({
      method: "POST",
      url: "/api/scenarios",
      headers: auth,
      payload: { name, batch: batchId, overrides: { perCase: 2, minGapHours: 72 } },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const s = saved.json<SavedScenario>();
    expect(s).toMatchObject({ name, batchId, overrides: { perCase: 2, minGapHours: 72 } });

    const list = (
      await app.inject({ method: "GET", url: `/api/scenarios?batch=${batchId}`, headers: auth })
    ).json<{ rows: SavedScenario[] }>();
    expect(list.rows.map((r) => r.id)).toContain(s.id);

    const reload = (
      await app.inject({ method: "GET", url: `/api/scenarios/${s.id}/reload`, headers: auth })
    ).json<ScenarioReloadResponse>();
    expect(reload.sameResult).toBe(true);
    expect(reload.result.diff).toEqual(s.result.diff);

    const dup = await app.inject({
      method: "POST",
      url: "/api/scenarios",
      headers: auth,
      payload: { name, batch: batchId, overrides: {} },
    });
    expect(dup.statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/scenarios",
          headers: auth,
          payload: { batch: batchId },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `/api/scenarios/${randomUUID()}/reload`, headers: auth }))
        .statusCode,
    ).toBe(404);
  });
});
