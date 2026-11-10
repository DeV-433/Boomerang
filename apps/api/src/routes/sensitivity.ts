import { desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { SensitivityResponse } from "@boomerang/core";
import { simSensitivity } from "@boomerang/db";
import type { SensitivitySummary } from "@boomerang/sim";
import type { AppDeps } from "../app";
import { configHash } from "./summary";

/** Step 9.2: the latest sensitivity sweep (npm run sim:sensitivity), or null before the first one. */
export async function sensitivityRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/sensitivity", async (): Promise<SensitivityResponse> => {
    const [row] = await deps.db.db
      .select()
      .from(simSensitivity)
      .orderBy(desc(simSensitivity.createdAt))
      .limit(1);
    if (!row) return { sweep: null };
    const r = row.result as SensitivitySummary;
    return {
      sweep: {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        strategy: row.strategy,
        size: row.size,
        seeds: row.seeds as string[],
        configHash: configHash(row.baseConfig),
        variations: r.variations,
        overall: r.overall,
        cells: r.cells,
      },
    };
  });
}
