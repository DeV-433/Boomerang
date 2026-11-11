import { createLogger, loadConfig, publicBaseUrl, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import { assertToolkitReady, createPayPal, OFFLINE_VERIFIER } from "@boomerang/paypal";
import { GroqClient, RecordingClient } from "@boomerang/agent";
import { configurePayLinks, configurePayPalWeb } from "@boomerang/cases";
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
// 10.3: offline mode has no PayPal client at all; actions become dry runs and webhooks are refused.
const offline = config.BOOMERANG_OFFLINE;
const { verifier, gateway } = offline
  ? { verifier: OFFLINE_VERIFIER, gateway: undefined }
  : createPayPal(config, { db: db.db, logger });
if (offline) logger.warn("offline mode: no PayPal client; every action is a dry run");
else if (!config.PAYPAL_WEBHOOK_ID) {
  logger.warn("PAYPAL_WEBHOOK_ID is not set: every incoming webhook will be rejected until it is");
}

const simulation =
  config.PAYPAL_ENVIRONMENT === "SANDBOX" && config.SIM_WEBHOOK_SECRET
    ? { secret: config.SIM_WEBHOOK_SECRET }
    : undefined;
logger.info({ simulatedEvents: Boolean(simulation) }, "simulated event route");
// 7C.6: messages link to the signed pay page when both settings are present (same as the worker,
// so a message approved here passes the same lint it was drafted against).
const payLinks =
  config.PAY_LINK_SECRET && publicBaseUrl(config)
    ? { secret: config.PAY_LINK_SECRET, baseUrl: publicBaseUrl(config)! }
    : null;
configurePayLinks(payLinks);
configurePayPalWeb(config.PAYPAL_ENVIRONMENT);
logger.info({ payPage: Boolean(config.PAY_LINK_SECRET), payLinksInMessages: Boolean(payLinks) }, "pay page");
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
  policyMode: offline ? "dry_run" : config.POLICY_MODE,
  gateway,
  payLinkSecret: config.PAY_LINK_SECRET,
  merchantName: config.MERCHANT_NAME,
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
logger.info(
  { environment: config.PAYPAL_ENVIRONMENT, mode: offline ? "dry_run" : config.POLICY_MODE, offline },
  "api ready",
);
