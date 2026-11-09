/**
 * Runs the treatment arm with Boomerang's rule-based loop through the simulator, stores the run,
 * and compares it with the baseline on the control arm (BUILD_PLAN 4.16, CP3).
 *   npm run sim:treatment -- [--batch latest|<id>]
 */
import { loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import {
  baselineStrategy,
  compareArms,
  findBatch,
  loadSimCases,
  parseSimConfig,
  Rng,
  rulesStrategy,
  saveRun,
  simulateArm,
} from "../src/index";
import { arg, dollars } from "./args";

const config = loadConfig();
const db = createDb(requireConfig(config, "DATABASE_URL"));
try {
  const batch = await findBatch(db.db, arg("batch", "latest")!);
  const simConfig = parseSimConfig(batch.simConfig);
  const rng = new Rng(batch.seed);

  const treatmentCases = await loadSimCases(db.db, batch.id, "treatment");
  const strategy = rulesStrategy();
  const treatment = simulateArm(simConfig, rng, treatmentCases, strategy);
  const control = simulateArm(simConfig, rng, await loadSimCases(db.db, batch.id, "control"), baselineStrategy(simConfig));
  const cmp = compareArms(control, treatment);
  // The same treatment cases under the baseline: separates the strategy's effect from luck of the split.
  const paired = compareArms(simulateArm(simConfig, rng, treatmentCases, baselineStrategy(simConfig)), treatment);
  const runId = await saveRun(db.db, {
    batchId: batch.id,
    arm: "treatment",
    strategy: strategy.name,
    seed: batch.seed,
    config: simConfig,
    results: treatment,
    metrics: { ...cmp.treatment, ...{ escalated: strategy.stats.escalated, heldForApproval: strategy.stats.heldForApproval } },
  });

  const row = (label: string, c: string, t: string) => console.log(`  ${label.padEnd(26)} ${c.padStart(16)} ${t.padStart(16)}`);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`treatment run ${runId}, batch ${batch.id} (seed ${batch.seed}), ${simConfig.horizonDays}-day horizon\n`);
  row("", "control (baseline)", "treatment (rules)");
  row("cases", String(cmp.control.cases), String(cmp.treatment.cases));
  row("at risk", dollars(cmp.control.atRiskCents), dollars(cmp.treatment.atRiskCents));
  row("recovered", dollars(cmp.control.recoveredCents), dollars(cmp.treatment.recoveredCents));
  row("recovery rate", pct(cmp.control.recoveryRate), pct(cmp.treatment.recoveryRate));
  row("contacts", String(cmp.control.contacts), String(cmp.treatment.contacts));
  row("contacts per $ recovered", cmp.control.contactsPerRecoveredDollar?.toFixed(4) ?? "n/a", cmp.treatment.contactsPerRecoveredDollar?.toFixed(4) ?? "n/a");
  row("median days to recovery", String(cmp.control.medianDaysToRecovery), String(cmp.treatment.medianDaysToRecovery));
  row("contacts after opt-out", String(cmp.control.contactsAfterOptOut), String(cmp.treatment.contactsAfterOptOut));
  row("disputes", String(cmp.control.disputes), String(cmp.treatment.disputes));
  console.log(`\n  uplift vs control arm:                ${(cmp.uplift * 100).toFixed(1)} points`);
  console.log(`  uplift vs baseline on the same cases: ${(paired.uplift * 100).toFixed(1)} points (baseline would recover ${pct(paired.control.recoveryRate)} of the treatment arm)`);
  console.log(`  A gap between the two is luck of the split; 7A.6 and 9.2 add intervals and more seeds.`);
  console.log(`  treatment escalated to a person: ${strategy.stats.escalated}, held for approval: ${strategy.stats.heldForApproval}, stopped: ${strategy.stats.stopped}`);
  console.log(`  gate blocks and holds by rule: ${JSON.stringify(strategy.stats.gateBlocks)}`);
  console.log(`\n  Simulated customers: this reflects the simulator's assumptions (sim/README.md), not real-world proof.`);
} finally {
  await db.close();
}
