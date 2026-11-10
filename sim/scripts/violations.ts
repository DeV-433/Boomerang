/**
 * Step 9.4: counts actions that broke any policy rule, across every stored Boomerang simulator run
 * and every executed live or dry-run action. Exits 1 if there is any.
 *   npm run check:violations [-- --database render]   (render: read-only check of RENDER_DATABASE_URL)
 */
import { loadPolicy } from "@boomerang/cases";
import { loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import { violationReport } from "../src/index";
import { arg } from "./args";

const config = loadConfig();
const render = arg("database") === "render";
if (render && !process.env.RENDER_DATABASE_URL) throw new Error("RENDER_DATABASE_URL is not set");
const url = render ? process.env.RENDER_DATABASE_URL! : requireConfig(config, "DATABASE_URL");
const db = createDb(url);
try {
  const r = await violationReport(db.db, await loadPolicy(db.db));
  console.log(`zero-violation check (${r.checkedAt})`);
  console.log(
    `  simulated: ${r.simulated.runs} Boomerang runs, ${r.simulated.cases} cases, ${r.simulated.contacts} contacts, ${r.simulated.violations.length} violations`,
  );
  console.log(
    `  live:      ${r.live.actions} executed actions, ${r.live.contacts} contacts, ${r.live.violations.length} violations`,
  );
  for (const v of [...r.simulated.violations, ...r.live.violations].slice(0, 50))
    console.log(
      `    rule ${v.rule} ${v.name}: case ${v.caseId}${v.runId ? ` run ${v.runId}` : ""}: ${v.detail}`,
    );
  console.log(`  total: ${r.total}${r.total ? ` by rule ${JSON.stringify(r.byRule)}` : ""}`);
  if (r.total > 0) process.exitCode = 1;
} finally {
  await db.close();
}
