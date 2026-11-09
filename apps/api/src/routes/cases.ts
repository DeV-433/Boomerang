import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CASE_GROUP_FIELDS,
  CASE_SORT_FIELDS,
  type CaseGroupsResponse,
  type CaseRow,
  type CasesResponse,
} from "@boomerang/core";
import { escalateCase, setCasePaused, type OperatorResult } from "@boomerang/cases";
import { caseStateEnum, cases, customers, laneEnum } from "@boomerang/db";
import type { AppDeps } from "../app";

const list = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    )
    .pipe(z.array(z.enum(values)));

/** Filters shared by the page and group queries. Lists are comma-separated; "none" matches a missing cause. */
const FilterQuery = z.object({
  lane: list(laneEnum.enumValues),
  state: list(caseStateEnum.enumValues),
  cause: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    ),
  arm: list(["control", "treatment", "none"] as const),
  batch: z.string().uuid().optional(),
  open: z.enum(["true", "false"]).optional(),
  paused: z.enum(["true", "false"]).optional(),
  q: z.string().trim().max(100).optional(),
});

const PageQuery = FilterQuery.extend({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  sort: z.enum(CASE_SORT_FIELDS).default("openedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

const GroupQuery = FilterQuery.extend({ by: z.enum(CASE_GROUP_FIELDS) });

function where(f: z.infer<typeof FilterQuery>): SQL | undefined {
  const parts: (SQL | undefined)[] = [];
  if (f.lane.length) parts.push(inArray(cases.lane, f.lane));
  if (f.state.length) parts.push(inArray(cases.state, f.state));
  if (f.cause.length) {
    const named = f.cause.filter((c) => c !== "none");
    parts.push(
      or(
        ...(named.length ? [inArray(cases.cause, named)] : []),
        ...(f.cause.includes("none") ? [isNull(cases.cause)] : []),
      ),
    );
  }
  if (f.arm.length) {
    const named = f.arm.filter((a): a is "control" | "treatment" => a !== "none");
    parts.push(
      or(
        ...(named.length ? [inArray(cases.experimentGroup, named)] : []),
        ...(f.arm.includes("none") ? [isNull(cases.experimentGroup)] : []),
      ),
    );
  }
  if (f.batch) parts.push(eq(cases.batchId, f.batch));
  if (f.open) parts.push(f.open === "true" ? isNull(cases.closedAt) : sql`${cases.closedAt} is not null`);
  if (f.paused) parts.push(eq(cases.paused, f.paused === "true"));
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    parts.push(or(ilike(cases.paypalRef, like), ilike(customers.email, like), ilike(customers.name, like)));
  }
  const defined = parts.filter((p): p is SQL => p !== undefined);
  return defined.length ? and(...defined) : undefined;
}

const SORT_COLUMNS = {
  openedAt: cases.openedAt,
  amountCents: cases.amountCents,
  recoveredCents: cases.recoveredCents,
  state: cases.state,
  cause: cases.cause,
  stage: cases.stage,
  lastContactAt: cases.lastContactAt,
  nextCheckAt: cases.nextCheckAt,
  lane: cases.lane,
  customer: sql`coalesce(${customers.name}, ${customers.email})`,
} as const;

const GROUP_COLUMNS = {
  cause: cases.cause,
  state: cases.state,
  lane: cases.lane,
  arm: cases.experimentGroup,
} as const;

function badRequest(error: z.ZodError) {
  return { error: error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ") };
}

const IdParams = z.object({ id: z.string().uuid() });
const PauseBody = z.object({ paused: z.boolean(), note: z.string().trim().max(500).optional() });
const EscalateBody = z.object({ note: z.string().trim().max(500).optional() });
/** One operator in this system (section 3 of the project documentation). */
export const OPERATOR_ACTOR = "operator";

/** Steps 6.4 and 6.6: server-side paging, filtering and sorting of cases, and group totals. */
export async function caseRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const db = deps.db.db;

  app.get("/cases", async (req, reply): Promise<CasesResponse | void> => {
    const parsed = PageQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error));
    const q = parsed.data;
    const filter = where(q);
    const order = q.dir === "asc" ? asc : desc;
    const rows = await db
      .select({ c: cases, customerName: customers.name, customerEmail: customers.email })
      .from(cases)
      .leftJoin(customers, eq(customers.id, cases.customerId))
      .where(filter)
      // Nulls last either way, then a stable tie-break so pages never overlap.
      .orderBy(sql`${SORT_COLUMNS[q.sort]} is null`, order(SORT_COLUMNS[q.sort]), asc(cases.id))
      .limit(q.limit)
      .offset(q.offset);
    const [{ total } = { total: 0 }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(cases)
      .leftJoin(customers, eq(customers.id, cases.customerId))
      .where(filter);
    return {
      rows: rows.map(({ c, customerName, customerEmail }): CaseRow => ({
        id: c.id,
        paypalRef: c.paypalRef,
        lane: c.lane,
        customer: customerName ?? customerEmail,
        customerEmail,
        amountCents: c.amountCents,
        currency: c.currency,
        cause: c.cause,
        state: c.state,
        stage: c.stage,
        contacts: c.contacts,
        lastContactAt: c.lastContactAt?.toISOString() ?? null,
        nextCheckAt: c.nextCheckAt?.toISOString() ?? null,
        recoveredCents: c.recoveredCents,
        arm: c.experimentGroup,
        batchId: c.batchId,
        paused: c.paused,
        simulated: c.simulated,
        openedAt: c.openedAt.toISOString(),
        closedAt: c.closedAt?.toISOString() ?? null,
        closedReason: c.closeReason,
      })),
      total: Number(total),
      offset: q.offset,
      limit: q.limit,
    };
  });

  app.get("/cases/groups", async (req, reply): Promise<CaseGroupsResponse | void> => {
    const parsed = GroupQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error));
    const col = GROUP_COLUMNS[parsed.data.by];
    const groups = await db
      .select({
        key: sql<string | null>`${col}::text`,
        cases: sql<number>`count(*)::int`,
        amountCents: sql<number>`coalesce(sum(${cases.amountCents}), 0)::bigint`,
        recoveredCents: sql<number>`coalesce(sum(${cases.recoveredCents}), 0)::bigint`,
      })
      .from(cases)
      .leftJoin(customers, eq(customers.id, cases.customerId))
      .where(where(parsed.data))
      .groupBy(col)
      .orderBy(desc(sql`sum(${cases.amountCents})`));
    return {
      by: parsed.data.by,
      groups: groups.map((g) => ({
        key: g.key,
        cases: Number(g.cases),
        amountCents: Number(g.amountCents),
        recoveredCents: Number(g.recoveredCents),
      })),
    };
  });

  // 6.5 row actions --------------------------------------------------------------------------------
  const send = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, r: OperatorResult) =>
    r.ok ? reply.code(200).send(r) : reply.code(r.status).send({ error: r.error });

  app.post("/cases/:id/pause", async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = PauseBody.safeParse(req.body ?? {});
    if (!params.success) return reply.code(400).send(badRequest(params.error));
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    return send(
      reply,
      await setCasePaused(db, params.data.id, body.data.paused, OPERATOR_ACTOR, body.data.note),
    );
  });

  app.post("/cases/:id/escalate", async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = EscalateBody.safeParse(req.body ?? {});
    if (!params.success) return reply.code(400).send(badRequest(params.error));
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    return send(reply, await escalateCase(db, params.data.id, OPERATOR_ACTOR, body.data.note));
  });
}
