import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ATTACK_SUITE, compromisedClient, runAttack, type Attack, type ModelClient } from "@boomerang/agent";
import { caseTrail, tamperDemo, verifyChain } from "@boomerang/audit";
import { eq } from "drizzle-orm";
import { cases } from "@boomerang/db";
import type {
  AttackRunResult,
  AuditVerifyResponse,
  TamperDemoResponse,
  TrustAttackResponse,
  TrustSuiteResponse,
} from "@boomerang/core";
import type { AppDeps } from "../app";

const AttackBody = z
  .object({
    reply: z.string().trim().min(1).max(2000).optional(),
    attackId: z.string().optional(),
  })
  .strict()
  .refine((b) => (b.reply === undefined) !== (b.attackId === undefined), {
    message: "send either reply or attackId",
  });

/**
 * Steps 7B.2, 7B.3 and 7B.6: the trust panel's API. Verification and the tamper demo only read the
 * real audit log (the demo edits a copy inside a rolled-back transaction). Attacks never execute
 * anything: they report what the classifier, the proposer and the gate would do.
 */
export async function trustRoutes(
  app: FastifyInstance,
  deps: AppDeps & { model?: ModelClient },
): Promise<void> {
  const verify = async (): Promise<AuditVerifyResponse> => {
    const started = performance.now();
    const v = await verifyChain(deps.db.db);
    return { ...v, verifiedAt: new Date().toISOString(), ms: Math.round(performance.now() - started) };
  };

  app.get("/audit/verify", async () => verify());

  app.post("/trust/tamper-demo", async (): Promise<TamperDemoResponse> => {
    const started = performance.now();
    const r = await tamperDemo(deps.db);
    const at = new Date().toISOString();
    const ms = Math.round(performance.now() - started);
    return {
      edited: r.edited,
      copy: { ...r.copy, verifiedAt: at, ms },
      real: { ...r.real, verifiedAt: at, ms },
      rolledBack: true,
    };
  });

  app.get("/trust/suite", async (): Promise<TrustSuiteResponse> => {
    const started = performance.now();
    const now = new Date();
    const results: AttackRunResult[] = [];
    for (const attack of ATTACK_SUITE) {
      const bad = compromisedClient(attack);
      results.push(await runAttack(attack, { classifier: bad, decider: bad, now }));
    }
    return {
      mode: "worst_case",
      passed: results.filter((r) => r.passed).length,
      total: results.length,
      results,
      ms: Math.round(performance.now() - started),
    };
  });

  app.post("/trust/attack", async (req, reply): Promise<TrustAttackResponse | void> => {
    const body = AttackBody.safeParse(req.body ?? {});
    if (!body.success)
      return reply.code(400).send({ error: body.error.issues.map((i) => i.message).join("; ") });
    const known = body.data.attackId ? ATTACK_SUITE.find((a) => a.id === body.data.attackId) : undefined;
    if (body.data.attackId && !known) return reply.code(404).send({ error: "unknown attack" });
    const attack: Attack = known ?? {
      id: "custom",
      name: "Your attack",
      category: "override",
      text: body.data.reply!,
      wants: "create_refund",
    };
    const started = performance.now();
    const now = new Date();
    // With a model key: the real classifier and decision model. Without: the worst-case stand-in.
    const result = deps.model
      ? await runAttack(attack, { classifier: deps.model, decider: deps.model, now })
      : await runAttack(attack, {
          classifier: compromisedClient(attack),
          decider: compromisedClient(attack),
          now,
        });
    req.log.info(
      {
        attack: attack.id,
        label: result.classification.label,
        action: result.proposal.action,
        passed: result.passed,
      },
      "trust attack run",
    );
    return { mode: deps.model ? "live" : "worst_case", result, ms: Math.round(performance.now() - started) };
  });

  // 7B.8: per-case audit receipt (CSV) ------------------------------------------------------------
  app.get("/cases/:id/receipt.csv", async (req, reply) => {
    const id = z
      .string()
      .uuid()
      .safeParse((req.params as { id?: string }).id);
    if (!id.success) return reply.code(400).send({ error: "id must be a case id" });
    const [c] = await deps.db.db.select().from(cases).where(eq(cases.id, id.data));
    if (!c) return reply.code(404).send({ error: "case not found" });
    const trail = await caseTrail(deps.db.db, c.id);
    const chain = await verifyChain(deps.db.db);
    const cell = (v: unknown) => {
      const t = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
      // Quote every cell, and defuse spreadsheet formulas (a cell starting with = + - @).
      return `"${(/^[=+\-@]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;
    };
    const lines = [
      ["Boomerang audit receipt"],
      ["case", c.id],
      ["reference", c.paypalRef],
      ["lane", c.lane],
      ["state", c.state],
      ["generated at", new Date().toISOString()],
      [
        "whole chain verified",
        chain.ok
          ? `yes, ${chain.checked} entries`
          : `NO: broken at entry ${chain.brokenAt} (${chain.reason})`,
      ],
      ["chain head id", chain.ok ? chain.lastId : ""],
      ["chain head hash", chain.ok ? chain.lastHash : ""],
      [],
      ["entry", "at", "actor", "kind", "data", "prev_hash", "hash"],
      ...trail.map((e) => [e.id, e.at.toISOString(), e.actor, e.kind, e.data, e.prevHash, e.hash]),
    ];
    const csv = lines.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="boomerang-receipt-${c.paypalRef}.csv"`)
      .send(csv);
  });
}
