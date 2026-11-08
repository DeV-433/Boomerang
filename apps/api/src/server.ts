import { createLogger, loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import { PayPalWebhookVerifier, TokenManager } from "@boomerang/paypal";
import { buildApp } from "./app";

const config = loadConfig();
const logger = createLogger({ name: "api", level: config.LOG_LEVEL });

const db = createDb(requireConfig(config, "DATABASE_URL"));
const tokens = new TokenManager({
  clientId: requireConfig(config, "PAYPAL_CLIENT_ID"),
  clientSecret: requireConfig(config, "PAYPAL_CLIENT_SECRET"),
  environment: config.PAYPAL_ENVIRONMENT,
});
if (!config.PAYPAL_WEBHOOK_ID) {
  logger.warn("PAYPAL_WEBHOOK_ID is not set: every incoming webhook will be rejected until it is");
}
const verifier = new PayPalWebhookVerifier(tokens, config.PAYPAL_WEBHOOK_ID);

const app = await buildApp({ db, verifier, logger });

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
