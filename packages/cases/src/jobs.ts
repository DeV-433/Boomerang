import { eq, sql } from "drizzle-orm";
import { jobs } from "@boomerang/db";
import { runCaseCheck, type CheckResult, type LoopDeps } from "./loop";

type ClaimedJob = Record<string, unknown> & {
  id: string;
  case_id: string;
  reason: string | null;
};

/**
 * Step 4.14: runs every due check, oldest first. Claims are atomic (FOR UPDATE SKIP LOCKED), so
 * several workers can run this safely. Only checks the loop is allowed to act on are claimed:
 * never control-arm cases, and a seeded batch's cases only after the batch has been started.
 */
export async function runDueJobs(deps: LoopDeps, options: { limit?: number; caseIds?: string[] } = {}): Promise<CheckResult[]> {
  const now = (deps.now ?? (() => new Date()))();
  const onlyCases = options.caseIds?.length
    ? sql`and c.id in (${sql.join(options.caseIds.map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql``;
  const claimed = await deps.db.execute<ClaimedJob>(sql`
    update jobs set status = 'running', attempts = jobs.attempts + 1
    where jobs.id in (
      select j.id from jobs j
      join cases c on c.id = j.case_id
      left join batches b on b.id = c.batch_id
      where j.status = 'pending'
        and j.run_at <= ${now.toISOString()}::timestamptz
        and coalesce(c.experiment_group::text, 'treatment') = 'treatment'
        and (c.batch_id is null or b.started_at is not null)
        ${onlyCases}
      order by j.run_at
      limit ${options.limit ?? 25}
      for update of j skip locked
    )
    returning jobs.id, jobs.case_id, jobs.reason`);

  const results: CheckResult[] = [];
  for (const job of claimed.rows) {
    try {
      const result = await runCaseCheck(deps, job.case_id);
      results.push(result);
      await deps.db.update(jobs).set({ status: "done", finishedAt: sql`now()` }).where(eq(jobs.id, job.id));
    } catch (error) {
      const message = (error as Error).message;
      deps.logger?.error({ caseId: job.case_id, err: error }, "case check failed");
      // Leave it for another attempt in 5 minutes, up to 5 attempts.
      await deps.db
        .update(jobs)
        .set({
          status: sql`case when ${jobs.attempts} >= 5 then 'failed'::job_status else 'pending'::job_status end`,
          runAt: new Date(now.getTime() + 5 * 60_000),
          lastError: message,
        })
        .where(eq(jobs.id, job.id));
      results.push({ caseId: job.case_id, outcome: "failed", detail: message });
    }
  }
  return results;
}
