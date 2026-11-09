import cors from "@fastify/cors";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Logger } from "@boomerang/core";
import type { DbHandle } from "@boomerang/db";
import type { WebhookVerifier } from "@boomerang/paypal";
import { healthRoutes } from "./routes/health";
import { operatorRoutes } from "./routes/operator";
import { webhookRoutes } from "./routes/webhooks";

export interface AppDeps {
  db: DbHandle;
  verifier: WebhookVerifier;
  logger?: Logger;
  /** Enables POST /webhooks/simulated. Set only in the sandbox with SIM_WEBHOOK_SECRET configured. */
  simulation?: { secret: string };
  /** Browser origins allowed to call the API (6.1). Empty means no cross-origin access. */
  corsOrigins?: string[];
  /** OPERATOR_TOKEN: required by every /api route. Unset keeps /api closed (503). */
  operatorToken?: string;
  /** POLICY_MODE, reported to the dashboard. */
  policyMode?: "dry_run" | "live";
}

/** DASHBOARD_ORIGINS plus local Vite dev outside production. */
export function corsOriginsFrom(config: { DASHBOARD_ORIGINS?: string; NODE_ENV: string }): string[] {
  const listed = (config.DASHBOARD_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return config.NODE_ENV === "production" ? listed : [...listed, "http://localhost:5173", "http://127.0.0.1:5173"];
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger | undefined,
    trustProxy: true, // Render terminates TLS in front of the service.
  });

  await app.register(cors, {
    origin: deps.corsOrigins ?? [],
    methods: ["GET", "POST"],
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
  });
  await app.register(healthRoutes, deps);
  // Encapsulated so its raw-body JSON parser does not affect the dashboard API.
  await app.register(webhookRoutes, deps);
  await app.register(operatorRoutes, { ...deps, prefix: "/api" });

  return app;
}
