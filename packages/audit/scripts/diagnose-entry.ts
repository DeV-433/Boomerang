/**
 * Diagnoses audit-hash mismatches (7B.1): for every entry whose stored content does not re-hash,
 * checks whether turning some ISO-date strings back into {} (how a JS Date was hashed before the
 * canonicalJson fix) reproduces the stored hash. Read-only.
 *   npx tsx packages/audit/scripts/diagnose-entry.ts
 */
import { asc } from "drizzle-orm";
import { loadConfig, requireConfig } from "@boomerang/core";
import { auditLog, computeAuditHash, createDb } from "@boomerang/db";
import { legacyDateVariants } from "../src/verify";

const db = createDb(requireConfig(loadConfig(), "DATABASE_URL"), { max: 1 });
try {
  const rows = await db.db.select().from(auditLog).orderBy(asc(auditLog.id));
  let ok = 0;
  let explained = 0;
  const unexplained: number[] = [];
  for (const r of rows) {
    const fields = { caseId: r.caseId, at: r.at, actor: r.actor, kind: r.kind };
    if (computeAuditHash(r.prevHash, { ...fields, data: r.data }) === r.hash) ok++;
    else if (
      legacyDateVariants(r.data).some((d) => computeAuditHash(r.prevHash, { ...fields, data: d }) === r.hash)
    )
      explained++;
    else unexplained.push(r.id);
  }
  console.log({
    entries: rows.length,
    verifyAsStored: ok,
    explainedByDateBug: explained,
    unexplained: unexplained.slice(0, 20),
    unexplainedCount: unexplained.length,
  });
} finally {
  await db.close();
}
