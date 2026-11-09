import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  ApprovalDecisionResponse,
  ApprovalRow,
  ApprovalsResponse,
  DraftMessage,
  Proposal,
} from "@boomerang/core";
import { decideApproval, lintEditedMessage } from "@boomerang/cases";
import { actions, approvals, approvalStatusEnum, cases, customers, events } from "@boomerang/db";
import type { AppDeps } from "../app";
import { OPERATOR_ACTOR } from "./cases";

const REPLY_EVENT = "BOOMERANG.CUSTOMER.REPLY";

const ListQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : ["pending"],
    )
    .pipe(z.array(z.enum(approvalStatusEnum.enumValues)).min(1)),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const DecisionBody = z
  .object({
    decision: z.enum(["approve", "edit", "reject"]),
    note: z.string().trim().max(500).optional(),
    message: z
      .object({ subject: z.string().trim().min(1).max(200).optional(), body: z.string().min(1).max(5000) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => (b.decision === "edit") === (b.message !== undefined), {
    message: "message is required for edit, and only for edit",
  });

/** Steps 6.9 and 6.10: the approval queue and the operator's decision on one held action. */
export async function approvalRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const db = deps.db.db;

  app.get("/approvals", async (req, reply): Promise<ApprovalsResponse | void> => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const rows = await db
      .select({
        ap: approvals,
        ac: actions,
        c: cases,
        customerName: customers.name,
        customerEmail: customers.email,
      })
      .from(approvals)
      .innerJoin(actions, eq(actions.id, approvals.actionId))
      .innerJoin(cases, eq(cases.id, actions.caseId))
      .leftJoin(customers, eq(customers.id, cases.customerId))
      .where(inArray(approvals.status, parsed.data.status))
      .orderBy(desc(approvals.createdAt))
      .limit(parsed.data.limit);

    // The latest customer reply per case, kept verbatim for the labelled block (never fed to a model here).
    const caseIds = [...new Set(rows.map((r) => r.c.id))];
    const replies = caseIds.length
      ? await db
          .select({ caseId: events.caseId, payload: events.payload, receivedAt: events.receivedAt })
          .from(events)
          .where(and(eq(events.type, REPLY_EVENT), inArray(events.caseId, caseIds)))
          .orderBy(desc(events.receivedAt))
      : [];
    const latestReply = new Map<string, ApprovalRow["customerReply"]>();
    for (const r of replies) {
      if (!r.caseId || latestReply.has(r.caseId)) continue;
      const res = (r.payload as { resource?: { text?: unknown; classification?: unknown } }).resource ?? {};
      if (typeof res.text !== "string" || res.text.length === 0) continue;
      latestReply.set(r.caseId, {
        text: res.text.slice(0, 4000),
        receivedAt: r.receivedAt.toISOString(),
        label: typeof res.classification === "string" ? res.classification : null,
      });
    }

    return {
      rows: rows.map(({ ap, ac, c, customerName, customerEmail }) => ({
        approvalId: ap.id,
        actionId: ac.id,
        status: ap.status,
        createdAt: ap.createdAt.toISOString(),
        decidedAt: ap.decidedAt?.toISOString() ?? null,
        decidedBy: ap.decidedBy,
        note: ap.note,
        case: {
          id: c.id,
          paypalRef: c.paypalRef,
          lane: c.lane,
          customer: customerName ?? customerEmail,
          amountCents: c.amountCents,
          currency: c.currency,
          stage: c.stage,
          state: c.state,
        },
        action: ac.action,
        proposedBy: ac.proposedBy,
        reason: ac.reason,
        confidence: ac.confidence,
        message: ((ap.editedMessage ?? ac.message) as DraftMessage | null) ?? null,
        gate: {
          verdict: ac.gateVerdict,
          reasons: Array.isArray(ac.gateReasons) ? (ac.gateReasons as unknown[]).map(String) : [],
        },
        customerReply: latestReply.get(c.id) ?? null,
      })),
    };
  });

  app.post("/approvals/:id/decision", async (req, reply): Promise<ApprovalDecisionResponse | void> => {
    const id = z
      .string()
      .uuid()
      .safeParse((req.params as { id?: string }).id);
    if (!id.success) return reply.code(400).send({ error: "id must be an approval id" });
    const body = DecisionBody.safeParse(req.body ?? {});
    if (!body.success)
      return reply.code(400).send({
        error: body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      });
    const d = body.data;

    const [row] = await db
      .select({ ap: approvals, ac: actions })
      .from(approvals)
      .innerJoin(actions, eq(actions.id, approvals.actionId))
      .where(eq(approvals.id, id.data));
    if (!row) return reply.code(404).send({ error: "approval not found" });
    if (row.ap.status !== "pending") return reply.code(409).send({ error: `already ${row.ap.status}` });

    let editedMessage: DraftMessage | undefined;
    if (d.decision === "edit") {
      const original = row.ac.message as DraftMessage | null;
      if (!original) return reply.code(409).send({ error: "this action has no message to edit" });
      const lint = await lintEditedMessage(db, row.ac.id, d.message!.body);
      if (!lint.ok)
        return lint.status === 422
          ? reply
              .code(422)
              .send({ error: "the edited message failed the message checks", issues: lint.issues })
          : reply.code(404).send({ error: lint.error });
      // The operator's wording replaces the drafted note; the template's other fields stay as they were.
      editedMessage = {
        ...original,
        subject: d.message!.subject ?? original.subject,
        body: d.message!.body,
        personalNote: undefined,
      };
    }

    const result = await decideApproval(
      { db, gateway: deps.gateway, mode: deps.policyMode, logger: deps.logger, now: deps.now },
      row.ac.id,
      {
        approve: d.decision !== "reject",
        by: OPERATOR_ACTOR,
        note: d.note,
        editedMessage: editedMessage as Proposal["message"] | undefined,
      },
    );
    if (result.outcome === "skipped")
      return reply.code(409).send({ error: result.detail ?? "nothing pending for this action" });
    return { outcome: result.outcome, detail: result.detail ?? null };
  });
}
