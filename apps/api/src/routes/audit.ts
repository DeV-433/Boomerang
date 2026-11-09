import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AUDIT_ENTRY_KINDS,
  type AuditEntry,
  type AuditListResponse,
  type CaseAuditResponse,
} from "@boomerang/core";
import { auditLog, cases } from "@boomerang/db";
import type { AppDeps } from "../app";

const ListQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  kind: z
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
    .pipe(z.array(z.enum(AUDIT_ENTRY_KINDS))),
  case: z.string().uuid().optional(),
  actor: z.string().trim().max(100).optional(),
  q: z.string().trim().max(100).optional(),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

const toEntry = (r: typeof auditLog.$inferSelect): AuditEntry => ({
  id: r.id,
  caseId: r.caseId,
  at: r.at.toISOString(),
  actor: r.actor,
  kind: r.kind as AuditEntry["kind"],
  data: r.data as Record<string, unknown>,
  hash: r.hash,
  prevHash: r.prevHash,
});

const literal = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Steps 6.7 and 6.8: the searchable decision log, and one case's ordered trail. Read-only. */
export async function auditRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const db = deps.db.db;

  app.get("/audit", async (req, reply): Promise<AuditListResponse | void> => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const q = parsed.data;
    const parts: SQL[] = [];
    if (q.kind.length) parts.push(inArray(auditLog.kind, q.kind));
    if (q.case) parts.push(eq(auditLog.caseId, q.case));
    if (q.actor) parts.push(ilike(auditLog.actor, literal(q.actor)));
    if (q.q)
      parts.push(
        or(
          ilike(cases.paypalRef, literal(q.q)),
          ilike(auditLog.actor, literal(q.q)),
          sql`${auditLog.data}::text ilike ${literal(q.q)}`,
        )!,
      );
    const filter = parts.length ? and(...parts) : undefined;
    const rows = await db
      .select({ a: auditLog, paypalRef: cases.paypalRef, lane: cases.lane, caseState: cases.state })
      .from(auditLog)
      .leftJoin(cases, eq(cases.id, auditLog.caseId))
      .where(filter)
      .orderBy(q.dir === "asc" ? asc(auditLog.id) : desc(auditLog.id))
      .limit(q.limit)
      .offset(q.offset);
    const [{ total } = { total: 0 }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(auditLog)
      .leftJoin(cases, eq(cases.id, auditLog.caseId))
      .where(filter);
    return {
      rows: rows.map((r) => ({
        ...toEntry(r.a),
        paypalRef: r.paypalRef,
        lane: r.lane,
        caseState: r.caseState,
      })),
      total: Number(total),
      offset: q.offset,
      limit: q.limit,
    };
  });

  app.get("/cases/:id/audit", async (req, reply): Promise<CaseAuditResponse | void> => {
    const id = z
      .string()
      .uuid()
      .safeParse((req.params as { id?: string }).id);
    if (!id.success) return reply.code(400).send({ error: "id must be a case id" });
    const [c] = await db
      .select({ id: cases.id, paypalRef: cases.paypalRef, state: cases.state })
      .from(cases)
      .where(eq(cases.id, id.data));
    if (!c) return reply.code(404).send({ error: "case not found" });
    // Chain order (id) is the order the entries were written; `at` can repeat within one transaction.
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.caseId, c.id))
      .orderBy(asc(auditLog.id));
    return { caseId: c.id, paypalRef: c.paypalRef, state: c.state, entries: entries.map(toEntry) };
  });
}
