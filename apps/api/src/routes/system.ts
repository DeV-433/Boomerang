import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SystemStatus } from "@boomerang/core";
import { effectiveMode, setSystemPaused } from "@boomerang/cases";
import { systemState } from "@boomerang/db";
import type { AppDeps } from "../app";
import { OPERATOR_ACTOR } from "./cases";

const PauseBody = z.object({ paused: z.boolean() }).strict();

/** Step 6.11: the global pause. The gate and the executor read it on every check, so it takes effect within one worker cycle. */
export async function systemRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const db = deps.db.db;
  const status = async (): Promise<SystemStatus> => {
    const [row] = await db.select().from(systemState).where(eq(systemState.id, 1));
    const m = await effectiveMode(db, deps.policyMode ?? "dry_run");
    return {
      paused: row?.paused ?? false,
      pausedBy: row?.pausedBy ?? null,
      changedAt: row?.changedAt.toISOString() ?? null,
      mode: m.mode,
      apiMode: m.apiMode,
      workerMode: m.workerMode,
      workerSeenAt: m.workerSeenAt?.toISOString() ?? null,
    };
  };

  app.get("/system", async () => status());

  app.post("/system/pause", async (req, reply): Promise<SystemStatus | void> => {
    const body = PauseBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'body must be {"paused": true|false}' });
    await setSystemPaused(db, body.data.paused, OPERATOR_ACTOR);
    req.log.warn(
      { paused: body.data.paused },
      body.data.paused ? "operator paused all activity" : "operator resumed all activity",
    );
    return status();
  });
}
