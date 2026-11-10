import type { FastifyInstance } from "fastify";
import type { ViolationsResponse } from "@boomerang/core";
import { loadPolicy } from "@boomerang/cases";
import { violationReport } from "@boomerang/sim";
import type { AppDeps } from "../app";

/** Step 9.4: actions that broke a policy rule, across stored Boomerang runs and executed actions. */
export async function violationRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/violations", async (): Promise<ViolationsResponse> => {
    const db = deps.db.db;
    const r = await violationReport(db, await loadPolicy(db), (deps.now ?? (() => new Date()))());
    // Cap the lists; the counts stay exact.
    return {
      ...r,
      simulated: { ...r.simulated, violations: r.simulated.violations.slice(0, 100) },
      live: { ...r.live, violations: r.live.violations.slice(0, 100) },
    };
  });
}
