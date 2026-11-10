/**
 * Step 9.2: sensitivity sweep. Re-runs the experiment (baseline vs Boomerang's rules) on batches
 * planned in memory for several seeds and simulator variations, and stores the spread of uplift
 * for the dashboard. No PayPal calls and no cases are written.
 *   npm run sim:sensitivity -- [--seeds 5] [--size 300] [--seed-prefix sens]
 * The agent is not used here: a sweep needs thousands of decisions, more than the free model tier
 * allows. The agent's own result (5.10) matched the rules on demo-1.
 */
import { loadConfig, requireConfig } from "@boomerang/core";
import { createDb, simSensitivity } from "@boomerang/db";
import { loadSimConfig, runSensitivity } from "../src/index";
import { arg } from "./args";

const config = loadConfig();
const base = loadSimConfig();
const n = Number(arg("seeds", "5"));
const prefix = arg("seed-prefix", "sens")!;
const seeds = Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);
const size = Number(arg("size", String(base.batch.size)));
const started = Date.now();

const result = await runSensitivity({
  base,
  seeds,
  size,
  onCell: (c, done, total) =>
    console.error(
      `  ${String(done).padStart(3)}/${total} ${c.variation.padEnd(20)} ${c.seed.padEnd(8)} same cases ${c.upliftSameCases.toFixed(1).padStart(6)}, vs control ${c.upliftVsControl.toFixed(1).padStart(6)}`,
    ),
});

const f = (x: number) => `${x > 0 ? "+" : ""}${x.toFixed(1)}`;
console.log(
  `\nsensitivity: ${seeds.length} seeds x ${result.variations.length} variations, ${size} cases each\n`,
);
console.log(`  ${"variation".padEnd(40)} ${"same cases (min / median / max)".padEnd(32)} vs control`);
for (const v of result.variations) {
  console.log(
    `  ${v.label.padEnd(40)} ${`${f(v.sameCases.min)} / ${f(v.sameCases.median)} / ${f(v.sameCases.max)}`.padEnd(32)} ${f(v.vsControl.min)} / ${f(v.vsControl.median)} / ${f(v.vsControl.max)}`,
  );
}
const o = result.overall;
console.log(
  `\n  overall: same cases ${f(o.sameCases.min)} to ${f(o.sameCases.max)} points (median ${f(o.sameCases.median)}, ${Math.round(o.sameCases.positiveShare * 100)}% above zero)`,
);
console.log(
  `           vs control ${f(o.vsControl.min)} to ${f(o.vsControl.max)} points (median ${f(o.vsControl.median)}, ${Math.round(o.vsControl.positiveShare * 100)}% above zero)`,
);
const afterOptOut = result.cells.reduce((s, c) => s + c.contactsAfterOptOut, 0);
console.log(`  Boomerang contacts after opt-out across all cells: ${afterOptOut}`);

const db = createDb(requireConfig(config, "DATABASE_URL"));
try {
  const [row] = await db.db
    .insert(simSensitivity)
    .values({ strategy: result.strategy, size, seeds, baseConfig: base, result })
    .returning({ id: simSensitivity.id });
  console.log(`\nstored as ${row!.id} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  console.log(
    `  Simulated customers: this reflects the simulator's assumptions (sim/README.md), not real-world proof.`,
  );
} finally {
  await db.close();
}
