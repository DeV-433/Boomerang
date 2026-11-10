/**
 * Step 9.1: the full experiment on one seeded batch, in one command. Runs the fixed-schedule
 * baseline on the control arm, then Boomerang on the treatment arm, and prints recovered dollars,
 * uplift and its 95% bootstrap intervals. Both runs are stored, so the dashboard's summary shows
 * the same numbers.
 *   npm run sim:experiment -- [--batch latest|<id>] [--proposer rules|agent] [--pay-page] [--allow-fallback]
 * Never control-arm cases are worked live: this only simulates.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import { findBatch } from "../src/index";
import { arg } from "./args";

const config = loadConfig();
const db = createDb(requireConfig(config, "DATABASE_URL"));
// Resolve "latest" once, so both runs use the same batch even if another is seeded meanwhile.
const batch = await findBatch(db.db, arg("batch", "latest")!).finally(() => db.close());
console.log(`experiment on batch ${batch.name} (${batch.id}), seed ${batch.seed}\n`);

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const passOn = ["--pay-page", "--allow-fallback"].filter((f) => process.argv.includes(f));
const steps = [
  [here("./baseline.ts"), "--batch", batch.id, "--arm", "control"],
  [here("./treatment.ts"), "--batch", batch.id, "--proposer", arg("proposer", "rules")!, ...passOn],
];
for (const step of steps) {
  const r = spawnSync(process.execPath, ["--import", "tsx", ...step], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log();
}
