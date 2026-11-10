import { agentProposer, classifyPendingReplies, GroqClient, RecordingClient } from "@boomerang/agent";
import {
  configurePayLinks,
  pollInvoices,
  processPendingEvents,
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

async function tick(): Promise<void> {
  if (busy || stopping) return; // never overlap ticks
  busy = true;
  try {
    await pingDb(db.pool);
    if (model) await classifyPendingReplies(db.db, model, { logger });
    const processed = await processPendingEvents(db.db, { logger });
    if (paypal && Date.now() - lastPoll >= POLL_MS) {
      lastPoll = Date.now();
      try {
        await pollInvoices({
          db: db.db,
          gateway: paypal.gateway,
          merchantTimezone: DEFAULT_POLICY.hours.merchantTimezone,
          logger,
        });
      } catch (err) {
        logger.error({ err }, "invoice poll failed");
      }
    }
    const results = await runDueJobs(deps);
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
  await db.close();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

logger.info({ mode: deps.mode, offline, tickMs: TICK_MS, pollMs: POLL_MS }, "worker ready");
await tick();
