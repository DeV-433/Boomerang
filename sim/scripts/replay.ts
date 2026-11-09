/**
 * Phase 7A checks from the command line (read-only: replays write nothing and call no one).
 *   npm run sim:replay -- [--batch latest|<id>] [--run <stored treatment run id>] [--overrides '{"perCase":4}']
 * Without --overrides: replays the batch's treatment arm with the rules and the default policy,
 * compares it case by case with the latest stored rules run (7A.1), and replays twice to check the
 * results are byte-identical (7A.2). With --overrides: a what-if on the whole batch (7A.5, 7A.6).
 */
import { loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import {
  compareWithStoredRun,
  latestRun,
  loadReplay,
  PolicyOverridesSchema,
  replay,
  whatIf,
} from "../src/index";
import { arg, dollars } from "./args";

const db = createDb(requireConfig(loadConfig(), "DATABASE_URL"), { max: 2 });
try {
  const batch = arg("batch", "latest")!;
  const overridesArg = arg("overrides");
  if (overridesArg) {
    const input = await loadReplay(db.db, batch);
    const r = await whatIf(input, PolicyOverridesSchema.parse(JSON.parse(overridesArg)));
    const ci = r.interval;
    console.log(
      `what-if on ${r.batch.name}: ${r.batch.cases} cases, overrides ${JSON.stringify(r.overrides)}, ${r.elapsedMs} ms`,
    );
    console.log(
      `  recovered   ${dollars(r.diff.recoveredCents.base)} -> ${dollars(r.diff.recoveredCents.scenario)} (${r.diff.recoveredCents.delta >= 0 ? "+" : ""}${dollars(r.diff.recoveredCents.delta)}; 95% CI ${dollars(ci.recoveredCents.low)} to ${dollars(ci.recoveredCents.high)})`,
    );
    console.log(
      `  rate        ${r.diff.recoveryRate.deltaPoints.toFixed(1)} points (95% CI ${ci.recoveryRatePoints.low.toFixed(1)} to ${ci.recoveryRatePoints.high.toFixed(1)})`,
    );
    console.log(
      `  contacts    ${r.diff.contacts.base} -> ${r.diff.contacts.scenario}; escalations ${r.diff.escalations.base} -> ${r.diff.escalations.scenario}; cases changed ${r.diff.casesChanged}`,
    );
  } else {
    const input = await loadReplay(db.db, batch, "treatment");
    const runId = arg("run") ?? (await latestRun(db.db, input.batchId, "treatment", "boomerang-rules"))?.id;
    if (!runId) throw new Error("no stored rules run for this batch; pass --run");
    const started = performance.now();
    const first = await replay(input);
    const second = await replay(input);
    const cmp = await compareWithStoredRun(db.db, runId, first.results);
    console.log(
      `replay of ${input.batchName} treatment arm (${input.cases.length} cases) in ${Math.round(performance.now() - started)} ms for two replays`,
    );
    console.log(`  matches stored run ${runId}: ${cmp.matching}/${cmp.cases} cases`);
    for (const m of cmp.mismatches.slice(0, 5))
      console.log(
        `    ${m.caseId} ${m.field}: stored ${String(m.stored).slice(0, 80)} / replayed ${String(m.replayed).slice(0, 80)}`,
      );
    console.log(
      `  two replays byte-identical: ${first.fingerprint === second.fingerprint} (${first.fingerprint.slice(0, 16)}...)`,
    );
    process.exitCode = cmp.mismatches.length === 0 && first.fingerprint === second.fingerprint ? 0 : 1;
  }
} finally {
  await db.close();
}
