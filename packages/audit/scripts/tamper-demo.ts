/**
 * Step 7B.3: demo-only tamper. Edits one entry in a throwaway copy of the audit log (inside a
 * transaction that is rolled back), shows that verification catches it at that entry, and shows the
 * real log still verifies. Never writes to the real audit log.
 *   npx tsx packages/audit/scripts/tamper-demo.ts [entryId]
 */
import { loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import { tamperDemo } from "../src/tamper";
import { verifyChain } from "../src/verify";

const db = createDb(requireConfig(loadConfig(), "DATABASE_URL"), { max: 2 });
try {
  const before = await verifyChain(db.db);
  const entryId = process.argv[2] ? Number(process.argv[2]) : undefined;
  const r = await tamperDemo(db, { entryId });
  console.log(
    `real log before:  ${before.ok ? `intact, ${before.checked} entries` : `BROKEN at ${before.brokenAt}`}`,
  );
  console.log(
    `edited in a copy: entry ${r.edited.id} (${r.edited.kind} by ${r.edited.actor}): ${r.edited.change}`,
  );
  console.log(
    `copy verifies:    ${r.copy.ok ? "intact (the edit was NOT caught!)" : `BROKEN at entry ${r.copy.brokenAt} (${r.copy.reason}) after ${r.copy.checked} good entries`}`,
  );
  console.log(
    `real log after:   ${r.real.ok ? `intact, ${r.real.checked} entries` : `BROKEN at ${r.real.brokenAt}`}; copy rolled back: ${r.rolledBack}`,
  );
  process.exitCode = !r.copy.ok && r.copy.brokenAt === r.edited.id && r.real.ok ? 0 : 1;
} finally {
  await db.close();
}
