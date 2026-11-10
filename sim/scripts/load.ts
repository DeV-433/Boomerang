/**
 * Step 9.8: load check. Pushes a seeded batch's treatment cases through the real loop (stored
 * events -> cases, diagnosis, rules proposer, gate, dry-run executor, audit) on a virtual clock,
 * hour by hour, so holds, follow-ups and stage changes all happen. Dry run only: nothing is sent.
 *   npm run sim:seed -- --seed load-1 --size 2000 --mode offline --api http://localhost:3010
 *   npm run sim:load -- --batch <id> [--days 10] [--workers 4]
 * Refuses to run against a sandbox batch (real PayPal invoices) or in live mode.
 */
import { verifyChain } from "@boomerang/audit";
import { processPendingEvents, runDueJobs, startBatch, type LoopDeps } from "@boomerang/cases";
import { createLogger, loadConfig, requireConfig } from "@boomerang/core";
import { cases, createDb, jobs } from "@boomerang/db";
import { and, eq, sql } from "drizzle-orm";
import { findBatch } from "../src/index";
import { arg } from "./args";

const config = loadConfig();
const logger = createLogger({ name: "load", level: config.LOG_LEVEL });
const db = createDb(requireConfig(config, "DATABASE_URL"), { max: 12 });
const H = 3_600_000;
try {
  const batch = await findBatch(db.db, arg("batch", "latest")!);
  if (batch.mode !== "offline")
    throw new Error(`batch ${batch.name} is a ${batch.mode} batch; the load check only runs offline batches`);
  const days = Number(arg("days", "10"));
  const workers = Number(arg("workers", "4"));
  const [{ n: treatment }] = (await db.db
    .select({ n: sql<number>`count(*)::int` })
    .from(cases)
    .where(and(eq(cases.batchId, batch.id), eq(cases.experimentGroup, "treatment")))) as [{ n: number }];

  const start = new Date();
  let now = start;
  const deps: LoopDeps = { db: db.db, mode: "dry_run", logger, now: () => now };
  const t0 = performance.now();
  await processPendingEvents(db.db, { logger, now: () => now });
  const started = await startBatch(db.db, batch.id, now);
  const outcomes: Record<string, number> = {};
  let checks = 0;
  let errors = 0;
  const slowest = { ms: 0, at: "" };
  for (let hour = 0; hour <= days * 24; hour++) {
    now = new Date(start.getTime() + hour * H);
    for (;;) {
      const t = performance.now();
      // Several workers claim jobs at once (FOR UPDATE SKIP LOCKED), as replicas would.
      const batches = await Promise.all(
        Array.from({ length: workers }, () =>
          runDueJobs(deps, { limit: 25 }).catch((e: Error) => {
            errors++;
            logger.error({ err: e }, "load: runDueJobs failed");
            return [];
          }),
        ),
      );
      const results = batches.flat();
      if (results.length === 0) break;
      const ms = (performance.now() - t) / results.length;
      if (ms > slowest.ms) Object.assign(slowest, { ms, at: now.toISOString() });
      checks += results.length;
      for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    }
  }
  const seconds = (performance.now() - t0) / 1000;
  const failedJobs = await db.db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .innerJoin(cases, eq(cases.id, jobs.caseId))
    .where(and(eq(cases.batchId, batch.id), eq(jobs.status, "failed")));
  const chain = await verifyChain(db.db);
  console.log(
    `load check on ${batch.name}: ${treatment} treatment cases (${started} started), ${days} simulated days`,
  );
  console.log(
    `  ${checks} case checks in ${seconds.toFixed(1)}s (${(checks / seconds).toFixed(0)} per second, ${workers} workers)`,
  );
  console.log(`  slowest round: ${slowest.ms.toFixed(1)} ms per check`);
  console.log(`  outcomes: ${JSON.stringify(outcomes)}`);
  console.log(
    `  errors: ${errors}, failed jobs: ${failedJobs[0]!.n}, audit chain ${chain.ok ? `verified (${chain.checked} entries)` : `BROKEN at ${chain.brokenAt}`}`,
  );
  if (errors > 0 || failedJobs[0]!.n > 0 || !chain.ok) process.exitCode = 1;
} finally {
  await db.close();
}
