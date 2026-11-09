import { and, asc, desc, eq, sql } from "drizzle-orm";
import { batches, cases, simCaseResults, simProfiles, simRuns, type Database } from "@boomerang/db";
import type { SimConfig } from "./config";
import type { CaseResult, SimCase } from "./engine";
import type { ArmMetrics } from "./metrics";
import type { CustomerType, Lane } from "./types";

export async function findBatch(db: Database, idOrLatest: string) {
  const [batch] =
    idOrLatest === "latest"
      ? await db.select().from(batches).orderBy(desc(batches.createdAt)).limit(1)
      : await db.select().from(batches).where(eq(batches.id, idOrLatest));
  if (!batch) throw new Error(`batch not found: ${idOrLatest}`);
  return batch;
}

/** The batch's cases with their hidden profiles, in generation order. Optionally one arm only. */
export async function loadSimCases(db: Database, batchId: string, arm?: "control" | "treatment"): Promise<SimCase[]> {
  const rows = await db
    .select({
      caseId: cases.id,
      lane: cases.lane,
      amountCents: cases.amountCents,
      batchIndex: simProfiles.batchIndex,
      customerType: simProfiles.customerType,
      failureKind: simProfiles.failureKind,
    })
    .from(cases)
    .innerJoin(simProfiles, eq(simProfiles.caseId, cases.id))
    .where(and(eq(cases.batchId, batchId), arm ? eq(cases.experimentGroup, arm) : sql`true`))
    .orderBy(asc(simProfiles.batchIndex));
  return rows.map((r) => ({
    caseId: r.caseId,
    lane: r.lane as Lane,
    amountCents: r.amountCents,
    profile: {
      batchIndex: r.batchIndex,
      lane: r.lane as Lane,
      customerType: r.customerType as CustomerType,
      failureKind: (r.failureKind as "soft" | "hard" | null) ?? null,
    },
  }));
}

export async function saveRun(
  db: Database,
  run: {
    batchId: string;
    arm: "control" | "treatment";
    strategy: string;
    seed: string;
    config: SimConfig;
    results: CaseResult[];
    metrics: ArmMetrics;
  },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(simRuns)
      .values({ batchId: run.batchId, arm: run.arm, strategy: run.strategy, seed: run.seed, simConfig: run.config, metrics: run.metrics })
      .returning({ id: simRuns.id });
    const runId = row!.id;
    for (let i = 0; i < run.results.length; i += 200) {
      await tx.insert(simCaseResults).values(
        run.results.slice(i, i + 200).map((r) => ({
          runId,
          caseId: r.caseId,
          outcome: r.outcome,
          amountCents: r.amountCents,
          recoveredCents: r.recoveredCents,
          recoveredDay: r.recoveredDay,
          contacts: r.contacts,
          contactsAfterOptOut: r.contactsAfterOptOut,
          timeline: r.timeline,
        })),
      );
    }
    await tx.update(simRuns).set({ finishedAt: sql`now()` }).where(eq(simRuns.id, runId));
    return runId;
  });
}
