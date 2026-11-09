import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Logger } from "@boomerang/core";
import type { DbHandle } from "@boomerang/db";
import type { WebhookVerifier } from "@boomerang/paypal";
import { healthRoutes } from "./routes/health";
import { webhookRoutes } from "./routes/webhooks";

export interface AppDeps {
  db: DbHandle;
  verifier: WebhookVerifier;
  logger?: Logger;
  /** Enables POST /webhooks/simulated. Set only in the sandbox with SIM_WEBHOOK_SECRET configured. */
  simulation?: { secret: string };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger | undefined,
    trustProxy: true, // Render terminates TLS in front of the service.
  });

  await app.register(healthRoutes, deps);
  // Encapsulated so its raw-body JSON parser does not affect the dashboard API.
  await app.register(webhookRoutes, deps);

  return app;
}
