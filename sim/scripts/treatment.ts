/**
 * Runs the treatment arm through the simulator with Boomerang's loop, stores the run, and compares
 * it with the baseline (BUILD_PLAN 4.16 with the rules, 5.10 and 5.11 with the agent).
 *   npm run sim:treatment -- [--batch latest|<id>] [--proposer rules|agent] [--concurrency 6]
 * The agent run records every model call in model_calls and reuses cached answers, so a re-run is
 * free and gives the same decisions.
 * An agent run stops at the first fallback to the rules (quota spent, provider down) so its result
 * is never a silent mix of agent and rule decisions; re-run later and the cache picks up where it
 * stopped. --allow-rules-fallback lets such a run finish and reports how many decisions fell back.
 */
import { agentProposer, GroqClient, RecordingClient, UsageMeter } from "@boomerang/agent";
import { proposeByRules } from "@boomerang/cases";
import { loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import {
  baselineStrategy,
  compareArms,
  findBatch,
  loadSimCases,
  parseSimConfig,
  Rng,
  loopStrategy,
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
  const which = arg("proposer", "rules") as "rules" | "agent";
  const meter = new UsageMeter();
  const proposalSources: Record<string, number> = {};
  let proposer = proposeByRules as Parameters<typeof loopStrategy>[0]["proposer"];
  if (which === "agent") {
    const client = new RecordingClient(new GroqClient(requireConfig(config, "GROQ_API_KEY"), { rpm: config.GROQ_RPM }), {
      db: db.db,
      cache: true,
      runTag: `sim:${batch.seed}:treatment:agent`,
      meter,
    });
    const agent = agentProposer({ client, onValidated: (req, ok) => client.markValid(req, ok) });
    const allowFallback = process.argv.includes("--allow-rules-fallback");
    proposer = async (s, diagnosis, now) => {
      const p = await agent(s, diagnosis, now);
      const source = p.proposedBy === "rules (agent fallback)" ? "rules fallback" : p.proposedBy === "rules" ? "rules (clear-cut)" : String(p.meta?.model ?? p.proposedBy);
      proposalSources[source] = (proposalSources[source] ?? 0) + 1;
      if (source === "rules fallback" && !allowFallback) {
        throw new Error(`agent fell back to the rules (${String(p.meta?.fallback).slice(0, 300)}). Stopped so the result is not a mix; re-run later and cached answers are reused.`);
      }
      return p;
    };
  }
  const strategy = loopStrategy({ name: which === "agent" ? "boomerang-agent" : "boomerang-rules", proposer });
  const started = Date.now();
  const treatment = await simulateArm(simConfig, rng, treatmentCases, strategy, {
    concurrency: which === "agent" ? Number(arg("concurrency", "6")) : 1,
    onCase: (done, total) => {
      if (which === "agent" && (done % 10 === 0 || done === total)) {
        const t = meter.totals.all;
        console.error(`  ${done}/${total} cases, ${t.calls} model calls (${t.cachedCalls} cached), $${t.costUsd.toFixed(4)}, ${((Date.now() - started) / 60_000).toFixed(1)} min`);
      }
    },
  });
  const control = await simulateArm(simConfig, rng, await loadSimCases(db.db, batch.id, "control"), baselineStrategy(simConfig));
  const cmp = compareArms(control, treatment);
  // The same treatment cases under the baseline: separates the strategy's effect from luck of the split.
  const paired = compareArms(await simulateArm(simConfig, rng, treatmentCases, baselineStrategy(simConfig)), treatment);
  const runId = await saveRun(db.db, {
    batchId: batch.id,
    arm: "treatment",
    strategy: strategy.name,
    seed: batch.seed,
    config: simConfig,
    results: treatment,
    metrics: {
      ...cmp.treatment,
      escalated: strategy.stats.escalated,
      heldForApproval: strategy.stats.heldForApproval,
      model: which === "agent" ? meter.totals : null,
      modelCostPerRecoveredDollar: cmp.treatment.recoveredCents > 0 ? meter.totals.all.costUsd / (cmp.treatment.recoveredCents / 100) : null,
    },
  });

  const row = (label: string, c: string, t: string) => console.log(`  ${label.padEnd(26)} ${c.padStart(16)} ${t.padStart(16)}`);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`treatment run ${runId}, batch ${batch.id} (seed ${batch.seed}), ${simConfig.horizonDays}-day horizon\n`);
  row("", "control (baseline)", `treatment (${which})`);
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
  if (which === "agent") {
    // 5.11: tokens and cost per run and per recovered dollar.
    const t = meter.totals;
    console.log(`\n  model calls: ${t.all.calls} (${t.all.cachedCalls} answered from cache), tokens in ${t.all.inputTokens}, out ${t.all.outputTokens}, thinking ${t.all.thinkingTokens}`);
    for (const [kind, k] of Object.entries(t.byKind)) console.log(`    ${kind.padEnd(9)} ${k.calls} calls, $${k.costUsd.toFixed(4)}`);
    const perDollar = cmp.treatment.recoveredCents > 0 ? t.all.costUsd / (cmp.treatment.recoveredCents / 100) : null;
    console.log(`  proposals by source: ${JSON.stringify(proposalSources)}`);
    console.log(`  model cost: $${t.all.costUsd.toFixed(4)} for the run, $${perDollar?.toFixed(6) ?? "n/a"} per recovered dollar`);
  }
  console.log(`\n  Simulated customers: this reflects the simulator's assumptions (sim/README.md), not real-world proof.`);
} finally {
  await db.close();
}
