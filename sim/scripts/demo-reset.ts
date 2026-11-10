/**
 * Step 10.1: resets a LOCAL database to the demo state, from a fixed seed, in one command.
 *   npm run demo:reset [-- --skip-sensitivity]
 *
 * What it builds (everything offline: no PayPal call, no model call):
 *   1. an offline batch "demo" (seed demo-2026, 300 cases, split 150/150);
 *   2. the experiment on it: baseline on the control arm, Boomerang's rules on the treatment arm;
 *   3. the sensitivity sweep (5 seeds x 12 variations) unless --skip-sensitivity;
 *   4. the batch started and its treatment cases worked once by the loop (dry run);
 *   5. five organic invoice cases for the demo beats, each in a known state:
 *        INV2-DEMO-0000-0000-4500  $4,500  held for a person's approval (gate rule 9)
 *        INV2-DEMO-0000-0000-0120  $120    reminded, then the customer opted out: stopped (rule 3)
 *        INV2-DEMO-0000-0000-0075  $75     reminded; open its pay link from the Cases page
 *        INV2-DEMO-0000-0000-0240  $240    reminded, then paid: recovered
 *        INV2-DEMO-0000-0000-0600  $600    the customer opened a dispute: escalated (rule 2)
 * The loop runs at a fixed moment inside contact hours, so the result does not depend on when
 * the reset runs. Refuses any database that is not on this machine, and never touches Render's.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyChain } from "@boomerang/audit";
import {
  processPendingEvents,
  runCaseCheck,
  runDueJobs,
  setSystemPaused,
  startBatch,
  type LoopDeps,
} from "@boomerang/cases";
import { createLogger, loadConfig, requireConfig } from "@boomerang/core";
import { cases, createDb, customers, events, runMigrations } from "@boomerang/db";
import { eq, sql } from "drizzle-orm";
import { loadSimConfig, seedBatch, type EventPoster } from "../src/index";

const DEMO_SEED = "demo-2026";
const DEMO_SIZE = 300;
const H = 3_600_000;

const config = loadConfig();
const url = requireConfig(config, "DATABASE_URL");
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1", "::1", "db"].includes(host))
  throw new Error(`demo:reset only resets a database on this machine; DATABASE_URL points at ${host}`);
if (process.env.RENDER_DATABASE_URL && process.env.RENDER_DATABASE_URL === url)
  throw new Error("DATABASE_URL is the Render database; refusing to reset it");
const logger = createLogger({ name: "demo-reset", level: "warn" });
const started = Date.now();
const step = (msg: string) =>
  console.log(`  ${((Date.now() - started) / 1000).toFixed(0).padStart(3)}s  ${msg}`);

/** The latest weekday 11:00 in New York (16:00 UTC) before now: inside every contact window used. */
function demoMoment(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 16));
  if (d > now) d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

console.log(`resetting ${host} to the demo state (seed ${DEMO_SEED})`);
// 1. Empty database, current schema.
{
  const db = createDb(url, { max: 2 });
  await db.db.execute(sql`drop schema if exists public cascade`);
  await db.db.execute(sql`drop schema if exists drizzle cascade`);
  await db.db.execute(sql`create schema public`);
  await db.close();
  await runMigrations(url);
  step("database emptied and migrated");
}

const db = createDb(url, { max: 6 });
try {
  await setSystemPaused(db.db, false, "demo-reset");
  // Simulated events go straight into the store, exactly as the API's signed route would store them.
  const poster: EventPoster = async (rawBody) => {
    const payload = JSON.parse(rawBody) as { id: string; event_type: string; resource?: { id?: string } };
    await db.db
      .insert(events)
      .values({
        paypalEventId: payload.id,
        type: payload.event_type,
        resourceId: payload.resource?.id ?? null,
        payload,
        rawBody,
        headers: {},
        source: "simulated",
        simulated: true,
      })
      .onConflictDoNothing();
    return { status: 200, body: "{}" };
  };
  const at = demoMoment();
  const summary = await seedBatch({
    db: db.db,
    config: loadSimConfig(),
    seed: DEMO_SEED,
    size: DEMO_SIZE,
    mode: "offline",
    poster,
    simSecret: "demo-reset (events are stored directly)",
    now: at,
  });
  step(
    `batch seeded: ${summary.invoices} invoices, ${summary.subscriptions} subscriptions, ${summary.control}/${summary.treatment}`,
  );

  // 2 and 3. The experiment and the sweep, with the same scripts the README documents.
  const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
  const run = (script: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", here(script), ...args], {
      encoding: "utf8",
      env: { ...process.env, LOG_LEVEL: "warn" },
    });
    if (r.status !== 0) throw new Error(`${script} failed:\n${r.stderr.slice(-2000)}`);
    return r.stdout;
  };
  const exp = run("./experiment.ts", "--batch", summary.batchId);
  step(`experiment: ${exp.match(/uplift vs control arm:\s+(.*)/)?.[1] ?? "done"}`);
  if (!process.argv.includes("--skip-sensitivity")) {
    const sens = run("./sensitivity.ts", "--seeds", "5");
    step(`sensitivity: ${sens.match(/overall: (.*)/)?.[1] ?? "done"}`);
  }

  // 4. Start the batch; the loop works each treatment case once (dry run).
  let now = at;
  const deps: LoopDeps = { db: db.db, mode: "dry_run", logger, now: () => now };
  await startBatch(db.db, summary.batchId, at);
  let checks = 0;
  for (;;) {
    const r = await runDueJobs(deps, { limit: 50 });
    if (r.length === 0) break;
    checks += r.length;
  }
  step(`batch started at ${at.toISOString()}; ${checks} treatment cases checked`);

  // 5. The organic demo cases.
  const store = async (type: string, resource: unknown, id: string) => {
    const payload = { id, event_type: type, resource };
    await db.db.insert(events).values({
      paypalEventId: id,
      type,
      payload,
      rawBody: JSON.stringify(payload),
      headers: {},
      source: type.startsWith("BOOMERANG.") ? "poll" : "webhook",
    });
    await processPendingEvents(db.db, { now: () => now, logger });
  };
  const demo = [
    { cents: 450_000, name: "Northwind Studio" },
    { cents: 12_000, name: "Priya Patel" },
    { cents: 7_500, name: "Lucas Rossi" },
    { cents: 24_000, name: "Mei Chen" },
    { cents: 60_000, name: "Okafor Logistics" },
  ].map((d) => ({ ...d, ref: `INV2-DEMO-0000-0000-${String(d.cents / 100).padStart(4, "0")}` }));
  const caseIds: Record<string, string> = {};
  for (const d of demo) {
    await store(
      "BOOMERANG.INVOICE.OVERDUE",
      {
        invoice: {
          id: d.ref,
          status: "SENT",
          detail: {
            currency_code: "USD",
            payment_term: { due_date: new Date(at.getTime() - 12 * 24 * H).toISOString().slice(0, 10) },
          },
          primary_recipients: [
            {
              billing_info: {
                email_address: `${d.ref.toLowerCase()}@example.com`,
                name: { full_name: d.name },
              },
            },
          ],
          amount: { currency_code: "USD", value: (d.cents / 100).toFixed(2) },
          due_amount: { currency_code: "USD", value: (d.cents / 100).toFixed(2) },
        },
      },
      `POLL-OVERDUE-${d.ref}`,
    );
    const [c] = await db.db.select().from(cases).where(eq(cases.paypalRef, d.ref));
    await db.db
      .update(customers)
      .set({ timezone: "America/New_York" })
      .where(eq(customers.id, c!.customerId));
    caseIds[d.ref] = c!.id;
    await runCaseCheck(deps, c!.id);
  }
  const [big, optOut, payPage, paid, dispute] = demo.map((d) => d.ref) as [
    string,
    string,
    string,
    string,
    string,
  ];
  now = new Date(at.getTime() + 2 * H);
  await store(
    "BOOMERANG.CUSTOMER.REPLY",
    { paypal_ref: optOut, lane: "invoice", classification: "opt_out" },
    `WH-DEMO-REPLY-${optOut}`,
  );
  await runCaseCheck(deps, caseIds[optOut]!);
  await store("INVOICING.INVOICE.PAID", { invoice: { id: paid, status: "PAID" } }, `WH-DEMO-PAID-${paid}`);
  await store(
    "CUSTOMER.DISPUTE.CREATED",
    { dispute_id: "PP-D-DEMO-0600", disputed_transactions: [{ invoice_number: dispute }] },
    `WH-DEMO-DISPUTE-${dispute}`,
  );
  await runCaseCheck(deps, caseIds[dispute]!);

  const states = await db.db
    .select({ ref: cases.paypalRef, state: cases.state })
    .from(cases)
    .where(sql`${cases.paypalRef} like 'INV2-DEMO-%'`);
  const stateOf = (ref: string) => states.find((s) => s.ref === ref)?.state;
  step(
    `demo cases: ${[big, optOut, payPage, paid, dispute].map((r) => `${r.slice(-4)} ${stateOf(r)}`).join(", ")}`,
  );
  const chain = await verifyChain(db.db);
  step(`audit chain ${chain.ok ? `verified (${chain.checked} entries)` : `BROKEN at ${chain.brokenAt}`}`);
  if (!chain.ok) process.exitCode = 1;
  console.log(
    `\ndemo ready. Start the API and dashboard (offline is fine: BOOMERANG_OFFLINE=true) and sign in.`,
  );
} finally {
  await db.close();
}
