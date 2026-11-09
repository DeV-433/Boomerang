/**
 * Runs the fixed-schedule baseline over a seeded batch and stores the run (BUILD_PLAN 3.7, CP2).
 *   npm run sim:baseline -- [--batch latest|<id>] [--arm control|treatment]
 */
import { loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import {
  baselineStrategy,
  computeMetrics,
  findBatch,
  loadSimCases,
  metricsByLane,
  parseSimConfig,
  Rng,
  saveRun,
  simulateArm,
} from "../src/index";
import { arg, dollars } from "./args";

const config = loadConfig();
const db = createDb(requireConfig(config, "DATABASE_URL"));
try {
  const batch = await findBatch(db.db, arg("batch", "latest")!);
  const arm = arg("arm", "control") as "control" | "treatment";
  // The batch keeps the simulator config it was generated with, so a run is reproducible later.
  const simConfig = parseSimConfig(batch.simConfig);
  const cases = await loadSimCases(db.db, batch.id, arm);
  const strategy = baselineStrategy(simConfig);
  const results = await simulateArm(simConfig, new Rng(batch.seed), cases, strategy);
  const metrics = computeMetrics(results);
  const runId = await saveRun(db.db, {
    batchId: batch.id,
    arm,
    strategy: strategy.name,
    seed: batch.seed,
    config: simConfig,
    results,
    metrics,
  });

  console.log(
    `baseline run ${runId} on batch ${batch.id} (seed ${batch.seed}), ${arm} arm, ${cases.length} cases, ${simConfig.horizonDays}-day horizon`,
  );
  console.log(`  at risk            ${dollars(metrics.atRiskCents)}`);
  console.log(
    `  recovered          ${dollars(metrics.recoveredCents)}  (${(metrics.recoveryRate * 100).toFixed(1)}%, ${metrics.recoveredCases} cases)`,
  );
  console.log(
    `  contacts           ${metrics.contacts}  (${metrics.contactsPerRecoveredDollar?.toFixed(4) ?? "n/a"} per recovered dollar)`,
  );
  console.log(`  median recovery    ${metrics.medianDaysToRecovery ?? "n/a"} days`);
  console.log(
    `  disputes ${metrics.disputes}, opt-outs ${metrics.optOuts}, contacts after opt-out ${metrics.contactsAfterOptOut}`,
  );
  for (const [lane, m] of Object.entries(metricsByLane(results))) {
    console.log(
      `  ${lane.padEnd(13)} ${dollars(m.recoveredCents)} of ${dollars(m.atRiskCents)} (${(m.recoveryRate * 100).toFixed(1)}%)`,
    );
  }
} finally {
  await db.close();
}
