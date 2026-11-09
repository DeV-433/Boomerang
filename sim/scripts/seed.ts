/**
 * Seeds an experiment batch (BUILD_PLAN 3.3 to 3.5).
 *   npm run sim:seed -- --seed demo-1 [--size 300] [--mode sandbox|offline] [--api http://localhost:3000]
 * sandbox mode creates real backdated PayPal invoices; subscription failures always go through the
 * API's /webhooks/simulated route, so the API must be running with SIM_WEBHOOK_SECRET set.
 */
import { createLogger, loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import { createPayPal } from "@boomerang/paypal";
import { httpPoster, loadSimConfig, seedBatch } from "../src/index";
import { arg, dollars } from "./args";

const config = loadConfig();
if (config.PAYPAL_ENVIRONMENT !== "SANDBOX") throw new Error("seeding only runs against the sandbox");
const mode = arg("mode", "sandbox") as "sandbox" | "offline";
const logger = createLogger({ name: "seed", level: "info" });
const db = createDb(requireConfig(config, "DATABASE_URL"));
const started = Date.now();
try {
  const summary = await seedBatch({
    db: db.db,
    config: loadSimConfig(),
    seed: arg("seed", "demo-1")!,
    size: arg("size") ? Number(arg("size")) : undefined,
    mode,
    gateway: mode === "sandbox" ? createPayPal(config, { db: db.db, logger }).gateway : undefined,
    merchantEmail: config.PAYPAL_SANDBOX_MERCHANT_EMAIL,
    poster: httpPoster(arg("api", "http://localhost:3000")!),
    simSecret: requireConfig(config, "SIM_WEBHOOK_SECRET"),
    concurrency: Number(arg("concurrency", "4")),
    logger,
  });
  console.log(
    `\nbatch ${summary.batchId} (${mode}) seeded in ${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
  console.log(
    `  ${summary.invoices} invoice cases, ${summary.subscriptions} subscription cases, ${dollars(summary.atRiskCents)} at risk`,
  );
  console.log(`  control ${summary.control}, treatment ${summary.treatment}`);
} finally {
  await db.close();
}
