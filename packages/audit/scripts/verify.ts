/** Step 7B.1: verify the whole audit chain (read-only).   npx tsx packages/audit/scripts/verify.ts */
import { loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import { verifyChain } from "../src/verify";

const db = createDb(requireConfig(loadConfig(), "DATABASE_URL"), { max: 1 });
try {
  const started = performance.now();
  const v = await verifyChain(db.db);
  console.log(JSON.stringify({ ...v, ms: Math.round(performance.now() - started) }));
  process.exitCode = v.ok ? 0 : 1;
} finally {
  await db.close();
}
