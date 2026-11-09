import { createLogger, loadConfig, requireConfig } from "@boomerang/core";
import { createDb, pingDb } from "@boomerang/db";
import { assertToolkitReady, createPayPal } from "@boomerang/paypal";

/**
 * Long-running worker. Phase 1 only proves it runs and reaches the database; the overdue poller
 * (4.4) and follow-up scheduler (4.14) plug into this loop.
 */
const config = loadConfig();
const logger = createLogger({ name: "worker", level: config.LOG_LEVEL });
const db = createDb(requireConfig(config, "DATABASE_URL"), { max: 2 });

const toolkit = assertToolkitReady();
logger.info({ toolkitVersion: toolkit.version, enabled: toolkit.enabled }, "PayPal Agent Toolkit loaded");
// The gateway is used by the overdue poller (4.4) and executor (4.12).
export const paypal = createPayPal(config, { db: db.db, logger });

const TICK_MS = 60_000;
let stopping = false;

async function tick(): Promise<void> {
  try {
    await pingDb(db.pool);
    logger.debug("worker tick");
  } catch (err) {
    logger.error({ err }, "worker tick failed");
  }
}

const timer = setInterval(() => void tick(), TICK_MS);

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "worker shutting down");
  clearInterval(timer);
  await db.close();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

await tick();
logger.info({ mode: config.POLICY_MODE }, "worker ready");
