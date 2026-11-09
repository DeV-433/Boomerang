import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "@boomerang/api";
import { type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import { loadSimConfig } from "../src/config";
import type { EventPoster } from "../src/inject";
import { computeMetrics } from "../src/metrics";
import {
  applyOverrides,
  compareWithStoredRun,
  loadReplay,
  replay,
  REPLAY_BASE_POLICY,
  whatIf,
} from "../src/replay";
import { seedBatch } from "../src/seed";
import { saveRun } from "../src/store";

const SECRET = "replay-test-secret";

describe.skipIf(!hasTestDb)("what-if replay over a stored batch (7A.1 to 7A.5)", () => {
  let h: DbHandle;
  let app: FastifyInstance;
  let batchId: string;
  const config = loadSimConfig();
  const seed = `replay-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    h = await setupTestDb();
    app = await buildApp({
      db: h,
      verifier: { verify: async () => ({ verified: false, reason: "unused" }) },
      simulation: { secret: SECRET },
    });
    const poster: EventPoster = async (rawBody, headers) => {
      const res = await app.inject({ method: "POST", url: "/webhooks/simulated", headers, payload: rawBody });
      return { status: res.statusCode, body: res.body };
    };
    batchId = (
      await seedBatch({ db: h.db, config, seed, size: 80, mode: "offline", poster, simSecret: SECRET })
    ).batchId;
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("reads the batch in generation order and reproduces a stored run exactly (7A.1)", async () => {
    const input = await loadReplay(h.db, batchId, "treatment");
    expect(input.cases.map((c) => c.profile.batchIndex)).toEqual(
      [...input.cases.map((c) => c.profile.batchIndex)].sort((a, b) => a - b),
    );
    // The "original" run, stored the way sim:treatment stores it.
    const original = await replay(input, { name: "boomerang-rules" });
    const runId = await saveRun(h.db, {
      batchId,
      arm: "treatment",
      strategy: "boomerang-rules",
      seed,
      config: input.config,
      results: original.results,
      metrics: computeMetrics(original.results),
    });
    const again = await replay(await loadReplay(h.db, batchId, "treatment"));
    const cmp = await compareWithStoredRun(h.db, runId, again.results);
    expect(cmp.mismatches).toEqual([]);
    expect(cmp.matching).toBe(input.cases.length);
  });

  it("gives byte-identical results on every replay (7A.2)", async () => {
    const input = await loadReplay(h.db, batchId);
    const [a, b] = [await replay(input), await replay(input)];
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(JSON.stringify(a.results)).toBe(JSON.stringify(b.results));
  });

  it("sends nothing anywhere: no network call during a replay (7A.3)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("a replay must not touch the network");
    });
    try {
      const r = await replay(await loadReplay(h.db, batchId));
      expect(r.metrics.contacts).toBeGreaterThan(0); // it did "contact" simulated customers
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("changes the number of contacts when a cap changes (7A.4)", async () => {
    const input = await loadReplay(h.db, batchId);
    const base = await replay(input);
    const oneContact = await replay(input, { policy: applyOverrides(REPLAY_BASE_POLICY, { perCase: 1 }) });
    expect(oneContact.metrics.contacts).toBeLessThan(base.metrics.contacts);
    expect(oneContact.results.every((r) => r.contacts <= 1)).toBe(true);
  });

  it("reports the diff and its interval, and an unchanged policy is a zero diff (7A.5, 7A.6)", async () => {
    const input = await loadReplay(h.db, batchId);
    const same = await whatIf(input, {});
    expect(same.diff).toMatchObject({
      recoveredCents: { delta: 0 },
      contacts: { delta: 0 },
      casesChanged: 0,
    });
    expect(same.interval.recoveredCents).toMatchObject({ estimate: 0, low: 0, high: 0 });
    const strict = await whatIf(input, { perCase: 1 });
    expect(strict.diff.contacts.delta).toBeLessThan(0);
    expect(strict.diff.recoveredCents.delta).toBe(
      strict.scenario.recoveredCents - strict.base.recoveredCents,
    );
    expect(strict.interval.recoveredCents.low).toBeLessThanOrEqual(strict.interval.recoveredCents.estimate);
    expect(strict.interval.recoveredCents.high).toBeGreaterThanOrEqual(
      strict.interval.recoveredCents.estimate,
    );
  });
});
