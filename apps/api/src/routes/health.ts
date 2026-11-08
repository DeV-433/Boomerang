import type { FastifyInstance } from "fastify";
import { pingDb } from "@boomerang/db";
import type { AppDeps } from "../app";

export async function healthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get("/healthz", async (req, reply) => {
    try {
      await pingDb(deps.db.pool);
      return { status: "ok", db: "ok" };
    } catch (err) {
      req.log.error({ err }, "health check: database ping failed");
      return reply.code(503).send({ status: "degraded", db: "unreachable" });
    }
  });
}
