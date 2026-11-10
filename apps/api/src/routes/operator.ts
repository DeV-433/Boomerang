import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../app";
import { approvalRoutes } from "./approvals";
import { auditRoutes } from "./audit";
import { caseRoutes } from "./cases";
import { summaryRoutes } from "./summary";
import { systemRoutes } from "./system";
import { sensitivityRoutes } from "./sensitivity";
import { violationRoutes } from "./violations";
import { timelineRoutes } from "./timeline";
import { trustRoutes } from "./trust";
import { whatIfRoutes } from "./whatif";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time comparison of the presented bearer token with OPERATOR_TOKEN. */
export function tokenMatches(req: FastifyRequest, expected: string): boolean {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return presented.length > 0 && timingSafeEqual(digest(presented), digest(expected));
}

/**
 * Everything under /api is for the operator and needs OPERATOR_TOKEN. With no token configured the
 * API stays closed (503) rather than open.
 */
export async function operatorRoutes(
  app: FastifyInstance,
  opts: AppDeps & { prefix?: string },
): Promise<void> {
  // Child plugins get the deps without the prefix, or they would add "/api" a second time.
  const { prefix: _prefix, ...deps } = opts;
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") return; // CORS preflight carries no credentials
    if (!deps.operatorToken)
      return reply.code(503).send({ error: "operator access is not configured (OPERATOR_TOKEN)" });
    if (!tokenMatches(req, deps.operatorToken))
      return reply.code(401).send({ error: "missing or wrong operator token" });
  });
  await app.register(summaryRoutes, deps);
  await app.register(caseRoutes, deps);
  await app.register(auditRoutes, deps);
  await app.register(approvalRoutes, deps);
  await app.register(systemRoutes, deps);
  await app.register(whatIfRoutes, deps);
  await app.register(trustRoutes, deps);
  await app.register(timelineRoutes, deps);
  await app.register(sensitivityRoutes, deps);
  await app.register(violationRoutes, deps);
}
