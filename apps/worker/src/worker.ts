import { agentProposer, classifyPendingReplies, GroqClient, RecordingClient } from "@boomerang/agent";
import {
  configurePayLinks,
  configurePayPalWeb,
  pollInvoices,
  processPendingEvents,
  reportWorkerMode,
  runDueJobs,
  type LoopDeps,
} from "@boomerang/cases";
import { createLogger, loadConfig, publicBaseUrl, requireConfig } from "@boomerang/core";
import { createDb, pingDb } from "@boomerang/db";
import { assertToolkitReady, createPayPal } from "@boomerang/paypal";
import { DEFAULT_POLICY } from "@boomerang/policy";

/**
 * Long-running worker (a cron job is too coarse for follow-up timers):
 *   every TICK_MS    stored events become case changes (4.3), then due checks run the loop (4.14)
 *   every POLL_MS    PayPal invoices are listed to find overdue ones (4.4)
 */
const config = loadConfig();
const logger = createLogger({ name: "worker", level: config.LOG_LEVEL });
const db = createDb(requireConfig(config, "DATABASE_URL"), { max: 4 });

const toolkit = assertToolkitReady();
logger.info({ toolkitVersion: toolkit.version, enabled: toolkit.enabled }, "PayPal Agent Toolkit loaded");
// 10.3: offline mode: no PayPal client, no invoice polling, dry run only.
const offline = config.BOOMERANG_OFFLINE;
const paypal = offline ? null : createPayPal(config, { db: db.db, logger });
if (offline) logger.warn("offline mode: no PayPal client; every action is a dry run, no invoice polling");

// 7C.6: reminders link to the signed pay page when both settings are present (same as the API).
const payLinks =
  config.PAY_LINK_SECRET && publicBaseUrl(config)
    ? { secret: config.PAY_LINK_SECRET, baseUrl: publicBaseUrl(config)! }
    : null;
configurePayLinks(payLinks);
configurePayPalWeb(config.PAYPAL_ENVIRONMENT);
logger.info({ payLinksInMessages: Boolean(payLinks) }, "pay links");

const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 5_000);
const POLL_MS = Number(process.env.INVOICE_POLL_MS ?? 5 * 60_000);

// 5.10: with a Groq key the agent proposes (rules are the fallback); without one, the rules do.
// The worker uses GROQ_API_KEY alone: GROQ_API_KEYS (teammates' keys) is for local simulations and evals only.
const model = config.GROQ_API_KEY
  ? new RecordingClient(new GroqClient(config.GROQ_API_KEY, { rpm: config.GROQ_RPM }), {
      db: db.db,
      runTag: "worker",
    })
  : null;
const deps: LoopDeps = {
  db: db.db,
  gateway: paypal?.gateway,
  logger,
  mode: offline ? "dry_run" : config.POLICY_MODE,
  ...(model
    ? { proposer: agentProposer({ client: model, onValidated: (req, ok) => model.markValid(req, ok) }) }
    : {}),
};
logger.info({ proposer: model ? "agent (rules fallback)" : "rules" }, "proposer");
let stopping = false;
let busy = false;
let lastPoll = 0;

/** B4: each stage fails on its own; one failing (the model, PayPal) never stops the others. */
async function stage<T>(name: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    logger.error({ err, stage: name }, `worker ${name} failed`);
    return fallback;
  }
}

async function tick(): Promise<void> {
  if (busy || stopping) return; // never overlap ticks
  busy = true;
  try {
    await pingDb(db.pool);
    // B15: tell the API which mode this worker runs in (approved actions go live only if both are live).
    await stage("mode report", undefined, () => reportWorkerMode(db.db, deps.mode ?? "dry_run"));
    if (model) await stage("reply classification", 0, () => classifyPendingReplies(db.db, model, { logger }));
    const processed = await stage("event processing", 0, () => processPendingEvents(db.db, { logger }));
    if (paypal && Date.now() - lastPoll >= POLL_MS) {
      lastPoll = Date.now();
      await stage("invoice poll", undefined, () =>
        pollInvoices({
          db: db.db,
          gateway: paypal.gateway,
          merchantTimezone: DEFAULT_POLICY.hours.merchantTimezone,
          logger,
        }).then(() => undefined),
      );
    }
    const results = await stage("due checks", [], () => runDueJobs(deps));
    if (processed > 0 || results.length > 0) {
      logger.info(
        {
          eventsProcessed: processed,
          checks: results.map((r) => `${r.outcome}${r.detail ? `:${r.detail}` : ""}`),
        },
        "worker tick",
      );
    }
  } catch (err) {
    logger.error({ err }, "worker tick failed");
  } finally {
    busy = false;
  }
}

const timer = setInterval(() => void tick(), TICK_MS);

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "worker shutting down");
  clearInterval(timer);
  // B5: let a running tick finish (Render allows 30 s after SIGTERM), so its claimed checks complete.
  const deadline = Date.now() + 25_000;
  while (busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (busy) logger.warn("tick still running at shutdown; its checks will be taken back after the lease");
  await db.close();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

logger.info({ mode: deps.mode, offline, tickMs: TICK_MS, pollMs: POLL_MS }, "worker ready");
await tick();
