import type { FastifyInstance } from "fastify";
import type { WhatIfDefaults, WhatIfResponse } from "@boomerang/core";
import { z } from "zod";
import {
  loadReplay,
  PolicyOverridesSchema,
  replay,
  REPLAY_BASE_POLICY,
  whatIf,
  type ReplayInput,
  type ReplayResult,
} from "@boomerang/sim";
import type { AppDeps } from "../app";

const Body = z
  .object({
    batch: z.union([z.literal("latest"), z.string().uuid()]).default("latest"),
    overrides: PolicyOverridesSchema.default({}),
  })
  .strict();

/** A batch's cases and its current-policy replay only change when the batch or the code does. */
const CACHE_MS = 10 * 60_000;
type Cached = { input: ReplayInput; base: ReplayResult; at: number };

/**
 * Step 7A.7: what-if on a stored batch. Replays every case of the batch under the current policy
 * and under the posted overrides through the real decision path against the simulator. Read-only:
 * nothing is written and nothing reaches PayPal.
 */
export async function whatIfRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const cache = new Map<string, Cached>();
  const inFlight = new Map<string, Promise<Cached>>();

  async function baseFor(batch: string): Promise<Cached> {
    const hit = cache.get(batch);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    const running = inFlight.get(batch);
    if (running) return running;
    const work = (async () => {
      const input = await loadReplay(deps.db.db, batch);
      const base = await replay(input, { policy: REPLAY_BASE_POLICY, name: "whatif-base" });
      const entry = { input, base, at: Date.now() };
      cache.set(batch, entry);
      cache.set(input.batchId, entry);
      return entry;
    })().finally(() => inFlight.delete(batch));
    inFlight.set(batch, work);
    return work;
  }

  app.get("/whatif/defaults", async (): Promise<WhatIfDefaults> => {
    const p = REPLAY_BASE_POLICY;
    return {
      perCase: p.caps.perCase,
      perCustomerPerWeek: p.caps.perCustomerPerWeek,
      minGapHours: p.thresholds.minGapHours,
      approvalAmountCents: p.thresholds.approvalAmountCents,
      confidenceFloor: p.thresholds.confidenceFloor,
      hoursStart: p.hours.start,
      hoursEnd: p.hours.end,
      contactDays: p.hours.days,
    };
  });

  app.post("/whatif", async (req, reply): Promise<WhatIfResponse | void> => {
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({
          error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
        });
    let entry: Cached;
    try {
      entry = await baseFor(parsed.data.batch);
    } catch (err) {
      if (err instanceof Error && /batch not found/.test(err.message))
        return reply.code(404).send({ error: "batch not found" });
      throw err;
    }
    if (entry.input.cases.length === 0)
      return reply.code(409).send({ error: "this batch has no simulated cases to replay" });
    return whatIf(entry.input, parsed.data.overrides, { base: entry.base, basePolicy: REPLAY_BASE_POLICY });
  });
}
