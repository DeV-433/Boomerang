import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CONTACT_ACTIONS,
  type TimelineEvent,
  type TimelineResponse,
  type TimelineRow,
  type TimelineRunInfo,
} from "@boomerang/core";
import { actions, auditLog, cases, events, jobs, simCaseResults, simProfiles, simRuns } from "@boomerang/db";
import { SIM_EPOCH, type TimelineEntry } from "@boomerang/sim";
import type { AppDeps } from "../app";

const DAY = 86_400_000;
const human = (s: string) => s.replace(/_/g, " ");

const Query = z.object({
  source: z.enum(["live", "run"]).default("live"),
  run: z.union([z.literal("latest"), z.string().uuid()]).default("latest"),
  /** Live only: one seeded batch, or organic cases (not from any batch). */
  batch: z.union([z.literal("organic"), z.string().uuid()]).optional(),
  /** Live only: just this case (the audit screen's small timeline). */
  case: z.string().uuid().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(30),
});

/** What a sim outcome means at the end of the run, and the gate rule that enforces it in the live system. */
const SIM_END: Record<string, { kind: TimelineEvent["kind"]; label: string; rule: TimelineEvent["rule"] }> = {
  opted_out: {
    kind: "stopped",
    label: "Stopped: customer opted out",
    rule: { number: 3, name: "opted_out" },
  },
  disputed: {
    kind: "escalated",
    label: "Handed to a person: dispute",
    rule: { number: 2, name: "dispute_open" },
  },
  unrecovered: { kind: "stopped", label: "Not recovered by the end of the run", rule: null },
};

/** A simulated day as a real date on the simulator's clock (day d starts at SIM_EPOCH + d days). */
const simDay = (day: number) => new Date(SIM_EPOCH.getTime() + day * DAY);
const iso = (d: Date) => d.toISOString();

function simEvents(caseId: string, outcome: string, timeline: TimelineEntry[], horizonDays: number) {
  const out: TimelineEvent[] = [];
  const add = (
    e: Omit<TimelineEvent, "id" | "caseId" | "future" | "rule"> & { rule?: TimelineEvent["rule"] },
  ) => out.push({ id: `${caseId}:${out.length}`, caseId, future: false, rule: null, ...e });
  add({ kind: "opened", start: iso(simDay(0)), end: null, label: "Case opened", detail: null });
  let last = 0;
  for (const t of timeline) {
    last = Math.max(last, t.day);
    const at = iso(simDay(t.day));
    switch (t.event) {
      case "contact":
        add({
          kind: "contact",
          start: at,
          end: null,
          label: human(t.kind),
          detail: `Reply: ${human(t.outcome)}${t.afterOptOut ? " (after opt-out)" : ""}`,
        });
        break;
      case "paypal_retry":
        add({
          kind: "paypal",
          start: at,
          end: null,
          label: `PayPal retry ${t.success ? "succeeded" : "failed"}`,
          detail: null,
        });
        break;
      case "paypal_failure_notice":
        add({
          kind: "paypal",
          start: at,
          end: null,
          label: "PayPal failure email",
          detail: `Reply: ${human(t.outcome)}`,
        });
        break;
      case "suspended":
        add({
          kind: "paypal",
          start: at,
          end: null,
          label: "PayPal suspended the subscription",
          detail: null,
        });
        break;
      case "promise_due":
        add({
          kind: "promise",
          start: at,
          end: iso(simDay(t.day + 1)),
          label: t.kept ? "Promise date (kept)" : "Promise date (broken)",
          detail: null,
        });
        break;
      case "page":
        add({
          kind: "page",
          start: at,
          end: null,
          label:
            t.action === "promise"
              ? "Promised a date on the pay page"
              : t.action === "pay"
                ? "Opened the pay page to pay"
                : "Opened the pay page to update the card",
          detail: t.promiseDay !== undefined ? `Promised day ${t.promiseDay}` : null,
        });
        break;
      case "paid":
        add({ kind: "recovered", start: at, end: null, label: "Paid", detail: `via ${human(t.via)}` });
        break;
    }
  }
  const end = SIM_END[outcome];
  if (end) {
    const day = outcome === "unrecovered" ? horizonDays : last;
    add({
      kind: end.kind,
      start: iso(simDay(day)),
      end: null,
      label: end.label,
      detail: null,
      rule: end.rule,
    });
  }
  return out;
}

/**
 * Step 8.1: the recovery timeline. One row per case with its contacts, scheduled follow-ups,
 * promises, PayPal events and the marker that ended it. Two sources: live cases (from actions,
 * jobs, events and the audit log) or a stored simulator run (from each case's recorded timeline,
 * placed on the simulator's clock). Read-only.
 */
export async function timelineRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const db = deps.db.db;

  async function runList(): Promise<TimelineRunInfo[]> {
    const rows = await db
      .select({
        id: simRuns.id,
        arm: simRuns.arm,
        strategy: simRuns.strategy,
        startedAt: simRuns.startedAt,
        cases: sql<number>`(select count(*)::int from ${simCaseResults} where ${simCaseResults.runId} = ${simRuns.id})`,
      })
      .from(simRuns)
      .where(isNotNull(simRuns.finishedAt))
      .orderBy(desc(simRuns.startedAt))
      .limit(20);
    return rows.filter((r) => r.cases > 0).map((r) => ({ ...r, startedAt: iso(r.startedAt) }));
  }

  app.get("/timeline", async (req, reply): Promise<TimelineResponse | void> => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const q = parsed.data;
    const now = (deps.now ?? (() => new Date()))();
    const runs = await runList();

    if (q.source === "run") {
      // "latest" prefers the newest treatment run: that is the one with Boomerang's decisions in it.
      const run =
        q.run === "latest"
          ? (runs.find((r) => r.arm === "treatment") ?? runs[0])
          : runs.find((r) => r.id === q.run);
      if (!run) return reply.code(404).send({ error: "no finished simulator run with results" });
      const [cfg] = await db.select({ c: simRuns.simConfig }).from(simRuns).where(eq(simRuns.id, run.id));
      const horizonDays = Number((cfg?.c as { horizonDays?: number } | undefined)?.horizonDays ?? 45);
      const results = await db
        .select({
          caseId: simCaseResults.caseId,
          outcome: simCaseResults.outcome,
          timeline: simCaseResults.timeline,
          amountCents: simCaseResults.amountCents,
          paypalRef: cases.paypalRef,
          lane: cases.lane,
          currency: cases.currency,
        })
        .from(simCaseResults)
        .innerJoin(cases, eq(cases.id, simCaseResults.caseId))
        .leftJoin(simProfiles, eq(simProfiles.caseId, simCaseResults.caseId))
        .where(eq(simCaseResults.runId, run.id))
        .orderBy(asc(simProfiles.batchIndex), asc(simCaseResults.caseId))
        .limit(q.limit)
        .offset(q.offset);
      const rows: TimelineRow[] = results.map((r) => ({
        caseId: r.caseId,
        paypalRef: r.paypalRef,
        lane: r.lane,
        amountCents: r.amountCents,
        currency: r.currency,
        state: r.outcome,
      }));
      const evts = results.flatMap((r) =>
        simEvents(r.caseId, r.outcome, r.timeline as TimelineEntry[], horizonDays),
      );
      return {
        source: "run",
        run,
        runs,
        rows,
        events: evts,
        total: run.cases,
        range: { start: iso(simDay(-1)), end: iso(simDay(horizonDays + 1)) },
        now: iso(now),
      };
    }

    // Live cases, newest first.
    const filter = q.case
      ? eq(cases.id, q.case)
      : q.batch === "organic"
        ? and(eq(cases.simulated, false), sql`${cases.batchId} is null`)
        : q.batch
          ? eq(cases.batchId, q.batch)
          : eq(cases.simulated, false);
    const caseRows = await db
      .select()
      .from(cases)
      .where(filter)
      .orderBy(desc(cases.openedAt), asc(cases.id))
      .limit(q.limit)
      .offset(q.offset);
    const [{ total } = { total: 0 }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(cases)
      .where(filter);
    const ids = caseRows.map((c) => c.id);
    const out: TimelineEvent[] = [];
    const push = (e: Omit<TimelineEvent, "id"> & { id?: string }) =>
      out.push({ ...e, id: e.id ?? `${e.caseId}:${e.kind}:${out.length}` });

    if (ids.length) {
      const [sent, pending, paypal, gated] = await Promise.all([
        db
          .select()
          .from(actions)
          .where(
            and(
              inArray(actions.caseId, ids),
              eq(actions.status, "executed"),
              inArray(actions.action, [...CONTACT_ACTIONS]),
            ),
          ),
        db
          .select()
          .from(jobs)
          .where(and(inArray(jobs.caseId, ids), eq(jobs.status, "pending"))),
        db
          .select({
            id: events.id,
            caseId: events.caseId,
            type: events.type,
            source: events.source,
            receivedAt: events.receivedAt,
          })
          .from(events)
          .where(inArray(events.caseId, ids)),
        // The newest deciding gate entry per closed case: it names the rule that stopped it.
        db
          .selectDistinctOn([auditLog.caseId], { caseId: auditLog.caseId, data: auditLog.data })
          .from(auditLog)
          .where(
            and(
              inArray(auditLog.caseId, ids),
              eq(auditLog.kind, "gated"),
              sql`(${auditLog.data}->>'decidedBy')::int > 0`,
            ),
          )
          .orderBy(auditLog.caseId, desc(auditLog.id)),
      ]);
      const ruleFor = new Map<string, TimelineEvent["rule"]>();
      for (const g of gated) {
        const d = g.data as { decidedBy?: number; checks?: { rule: number; name: string }[] };
        const name = d.checks?.find((c) => c.rule === d.decidedBy)?.name;
        if (g.caseId && d.decidedBy && name) ruleFor.set(g.caseId, { number: d.decidedBy, name });
      }

      for (const c of caseRows) {
        push({
          caseId: c.id,
          kind: "opened",
          start: iso(c.openedAt),
          end: null,
          label: "Case opened",
          detail: c.cause ? human(c.cause) : null,
          rule: null,
          future: false,
        });
        if (c.promiseDate) {
          const start = new Date(`${c.promiseDate}T00:00:00Z`);
          push({
            caseId: c.id,
            kind: "promise",
            start: iso(start),
            end: iso(new Date(start.getTime() + DAY)),
            label: `Promised to pay by ${c.promiseDate}`,
            detail: null,
            rule: null,
            future: start.getTime() + DAY > now.getTime(),
          });
        }
        if (c.closedAt) {
          const kind =
            c.state === "recovered" ? "recovered" : c.state === "escalated" ? "escalated" : "stopped";
          const rule = kind === "recovered" ? null : (ruleFor.get(c.id) ?? null);
          push({
            caseId: c.id,
            kind,
            start: iso(c.closedAt),
            end: null,
            label:
              kind === "recovered" ? "Recovered" : kind === "escalated" ? "Handed to a person" : "Stopped",
            detail: c.closeReason,
            rule,
            future: false,
          });
        }
      }
      for (const a of sent) {
        const msg = a.message as { subject?: string } | null;
        push({
          id: `action:${a.id}`,
          caseId: a.caseId,
          kind: "contact",
          start: iso(a.executedAt ?? a.createdAt),
          end: null,
          label: human(a.action),
          detail: msg?.subject ?? a.reason,
          rule: null,
          future: false,
        });
      }
      for (const j of pending)
        push({
          id: `job:${j.id}`,
          caseId: j.caseId,
          kind: "followup",
          start: iso(j.runAt),
          end: null,
          label: "Scheduled check",
          detail: j.reason,
          rule: null,
          future: j.runAt.getTime() > now.getTime(),
        });
      for (const e of paypal) {
        if (!e.caseId) continue;
        const page = e.source === "paypage";
        push({
          id: `event:${e.id}`,
          caseId: e.caseId,
          kind: page ? "page" : "paypal",
          start: iso(e.receivedAt),
          end: null,
          label: page
            ? e.type === "BOOMERANG.CUSTOMER.PAYMENT_UPDATED"
              ? "Payment method updated (pay page)"
              : "Promise from the pay page"
            : e.type,
          detail: page ? null : `via ${e.source}`,
          rule: null,
          future: false,
        });
      }
    }

    const times = out.flatMap((e) => [Date.parse(e.start), e.end ? Date.parse(e.end) : 0]).filter(Boolean);
    const lo = Math.min(now.getTime(), ...times);
    const hi = Math.max(now.getTime() + 7 * DAY, ...times);
    return {
      source: "live",
      run: null,
      runs,
      rows: caseRows.map((c) => ({
        caseId: c.id,
        paypalRef: c.paypalRef,
        lane: c.lane,
        amountCents: c.amountCents,
        currency: c.currency,
        state: c.state,
      })),
      events: out.sort((a, b) => a.start.localeCompare(b.start)),
      total,
      range: { start: iso(new Date(lo - DAY)), end: iso(new Date(hi + DAY)) },
      now: iso(now),
    };
  });
}
