import { createLogger, loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import { assertToolkitReady, createPayPal } from "@boomerang/paypal";
import { GroqClient, RecordingClient } from "@boomerang/agent";
import { buildApp, corsOriginsFrom } from "./app";

const config = loadConfig();
const logger = createLogger({ name: "api", level: config.LOG_LEVEL });

const db = createDb(requireConfig(config, "DATABASE_URL"));
const toolkit = assertToolkitReady();
logger.info(
  {
    toolkitVersion: toolkit.version,
    pinned: toolkit.pinned,
    installedTools: toolkit.installedTools,
    enabled: toolkit.enabled,
  },
  "PayPal Agent Toolkit loaded",
);
const { verifier, gateway } = createPayPal(config, { db: db.db, logger });
if (!config.PAYPAL_WEBHOOK_ID) {
  logger.warn("PAYPAL_WEBHOOK_ID is not set: every incoming webhook will be rejected until it is");
}

const simulation =
  config.PAYPAL_ENVIRONMENT === "SANDBOX" && config.SIM_WEBHOOK_SECRET
    ? { secret: config.SIM_WEBHOOK_SECRET }
    : undefined;
logger.info({ simulatedEvents: Boolean(simulation) }, "simulated event route");
const corsOrigins = corsOriginsFrom(config);
logger.info({ corsOrigins }, "dashboard origins");
if (!config.OPERATOR_TOKEN)
  logger.warn("OPERATOR_TOKEN is not set: the dashboard API (/api) stays closed until it is");
const app = await buildApp({
  db,
  verifier,
  logger,
  simulation,
  corsOrigins,
  operatorToken: config.OPERATOR_TOKEN,
  policyMode: config.POLICY_MODE,
  gateway,
  // 7B.6: typed attacks run against the real classifier and decision model (recorded for cost tracking).
  model: config.GROQ_API_KEY
    ? new RecordingClient(new GroqClient(config.GROQ_API_KEY, { rpm: config.GROQ_RPM }), {
        db: db.db,
        runTag: "trust-attack",
      })
    : undefined,
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, "shutting down");
  await app.close();
  await db.close();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: "0.0.0.0", port: config.PORT });
logger.info({ environment: config.PAYPAL_ENVIRONMENT, mode: config.POLICY_MODE }, "api ready");
