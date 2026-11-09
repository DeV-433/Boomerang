import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ArmTotals, SimArmMetrics, SimRunInfo, SummaryResponse } from "@boomerang/core";
import { batches, cases, simRuns, systemState, type Database } from "@boomerang/db";
import type { AppDeps } from "../app";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function totals(
  rows: { cases: number; atRisk: number; recovered: number; recoveredCases: number } | undefined,
): ArmTotals {
  const atRiskCents = Number(rows?.atRisk ?? 0);
  const recoveredCents = Number(rows?.recovered ?? 0);
  return {
    cases: Number(rows?.cases ?? 0),
    atRiskCents,
    recoveredCents,
    recoveredCases: Number(rows?.recoveredCases ?? 0),
    recoveryRate: atRiskCents === 0 ? 0 : recoveredCents / atRiskCents,
  };
}

const totalsSelect = {
  cases: sql<number>`count(*)::int`,
  atRisk: sql<number>`coalesce(sum(${cases.amountCents}), 0)::bigint`,
  recovered: sql<number>`coalesce(sum(${cases.recoveredCents}), 0)::bigint`,
  recoveredCases: sql<number>`count(*) filter (where ${cases.state} = 'recovered')::int`,
};

function points(control: ArmTotals | SimArmMetrics, treatment: ArmTotals | SimArmMetrics): number | null {
  if (control.cases === 0 || treatment.cases === 0) return null;
  return (treatment.recoveryRate - control.recoveryRate) * 100;
}

const runInfo = (r: typeof simRuns.$inferSelect): SimRunInfo => ({
  id: r.id,
  arm: r.arm,
  strategy: r.strategy,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

/** Step 6.2: at-risk, recovered, rate and the control comparison, live and simulated. */
export async function buildSummary(
  db: Database,
  opts: { batch?: string; treatmentRun?: string; mode: "dry_run" | "live" },
): Promise<SummaryResponse> {
  const [batch] =
    opts.batch && opts.batch !== "latest"
      ? await db.select().from(batches).where(eq(batches.id, opts.batch))
      : await db.select().from(batches).orderBy(desc(batches.createdAt)).limit(1);

  const byArm = batch
    ? await db
        .select({ arm: cases.experimentGroup, ...totalsSelect })
        .from(cases)
        .where(eq(cases.batchId, batch.id))
        .groupBy(cases.experimentGroup)
    : [];
  const live = {
    control: totals(byArm.find((r) => r.arm === "control")),
    treatment: totals(byArm.find((r) => r.arm === "treatment")),
  };
  const [organicRow] = await db.select(totalsSelect).from(cases).where(isNull(cases.batchId));

  const runs = batch
    ? await db
        .select()
        .from(simRuns)
        .where(and(eq(simRuns.batchId, batch.id), sql`${simRuns.metrics} is not null`))
        .orderBy(desc(simRuns.startedAt))
    : [];
  const control = runs.find((r) => r.arm === "control");
  const treatment = opts.treatmentRun
    ? runs.find((r) => r.id === opts.treatmentRun && r.arm === "treatment")
    : (runs.find((r) => r.arm === "treatment" && r.strategy === "boomerang-agent") ??
      runs.find((r) => r.arm === "treatment"));
  const withMetrics = (r: typeof control) =>
    r ? { ...runInfo(r), metrics: r.metrics as SimArmMetrics } : null;
  const simControl = withMetrics(control);
  const simTreatment = withMetrics(treatment);

  const [sys] = await db.select().from(systemState).where(eq(systemState.id, 1));
  return {
    batch: batch
      ? {
          id: batch.id,
          name: batch.name,
          seed: batch.seed,
          size: batch.size,
          mode: batch.mode,
          createdAt: batch.createdAt.toISOString(),
          startedAt: batch.startedAt?.toISOString() ?? null,
        }
      : null,
    live: { ...live, upliftPoints: points(live.control, live.treatment) },
    organic: totals(organicRow),
    simulated: {
      control: simControl,
      treatment: simTreatment,
      upliftPoints: simControl && simTreatment ? points(simControl.metrics, simTreatment.metrics) : null,
      runs: runs.map(runInfo),
    },
    system: { paused: sys?.paused ?? false, mode: opts.mode },
  };
}

export async function summaryRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get<{ Querystring: { batch?: string; treatmentRun?: string } }>("/summary", async (req, reply) => {
    const { batch, treatmentRun } = req.query;
    if (batch && batch !== "latest" && !UUID.test(batch))
      return reply.code(400).send({ error: "batch must be a batch id or 'latest'" });
    if (treatmentRun && !UUID.test(treatmentRun))
      return reply.code(400).send({ error: "treatmentRun must be a run id" });
    const summary = await buildSummary(deps.db.db, {
      batch,
      treatmentRun,
      mode: deps.policyMode ?? "dry_run",
    });
    if (batch && batch !== "latest" && !summary.batch)
      return reply.code(404).send({ error: "batch not found" });
    return summary;
  });
}
