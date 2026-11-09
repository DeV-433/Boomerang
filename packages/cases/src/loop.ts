import { and, eq, isNull, sql } from "drizzle-orm";
import { auditedTransaction, writeAudit } from "@boomerang/audit";
import {
  isContactAction,
  isEndState,
  isWaitAction,
  lintMessage,
  type Action,
  type Lane,
  type Proposal,
} from "@boomerang/core";
import { actions, approvals, batches, cases, type Database } from "@boomerang/db";
import type { PayPalGateway } from "@boomerang/paypal";
import { TOOL_WHITELIST } from "@boomerang/paypal";
import { evaluateGate, type GateDecision, type Policy } from "@boomerang/policy";
import type { Logger } from "@boomerang/core";
import { diagnose, type CaseSnapshot, type Diagnosis } from "./diagnose";
import { executeAction } from "./executor";
import { messageFacts } from "./messages";
import { proposeByRules } from "./propose";
import {
  closeCase,
  isSystemPaused,
  loadPolicy,
  loadSnapshot,
  lockCase,
  scheduleCheck,
  setState,
  type Tx,
} from "./store";

export type Proposer = (
  snapshot: CaseSnapshot,
  diagnosis: Diagnosis,
  now: Date,
) => Promise<Proposal> | Proposal;

export interface LoopDeps {
  db: Database;
  /** Absent: offline. No PayPal reads or writes; contacts are recorded as dry runs. */
  gateway?: PayPalGateway;
  now?: () => Date;
  logger?: Logger;
  /** Overrides the stored policy's mode (POLICY_MODE). */
  mode?: "dry_run" | "live";
  /** Defaults to the rule-based proposer (4.7); Phase 5 passes the agent with rules as fallback. */
  proposer?: Proposer;
}

export const enabledTools = (lane: Lane): readonly string[] => TOOL_WHITELIST[lane];

export interface CheckResult {
  caseId: string;
  outcome:
    "skipped" | "closed" | "held" | "waiting" | "deferred" | "executed" | "dry_run" | "cancelled" | "failed";
  detail?: string;
  decision?: GateDecision;
}

const H = 3_600_000;

/**
 * One turn of the common loop (section 7) for one case: close-out and diagnosis, proposal, gate,
 * then either execution, a hold for a person, a deferral, or an end state. Every step is audited.
 */
export async function runCaseCheck(deps: LoopDeps, caseId: string): Promise<CheckResult> {
  const now = (deps.now ?? (() => new Date()))();
  const policy = await loadPolicy(deps.db, deps.mode);
  const proposer = deps.proposer ?? proposeByRules;

  const step = await auditedTransaction(deps.db, async (tx): Promise<CheckResult & { execute?: string }> => {
    const c = await lockCase(tx, caseId);
    if (!c || isEndState(c.state)) return { caseId, outcome: "skipped", detail: "case has ended" };
    if (c.paused) return { caseId, outcome: "skipped", detail: "case paused by operator" };
    if (c.state !== "detected" && c.state !== "awaiting")
      return { caseId, outcome: "skipped", detail: `case is ${c.state}` };

    const snapshot = (await loadSnapshot(tx, caseId, now))!;
    const diagnosis = diagnose(snapshot, now);
    await setState(tx, caseId, c.state, "diagnosed", { cause: diagnosis.cause });
    await writeAudit(tx, {
      caseId,
      actor: diagnosis.method,
      kind: "diagnosed",
      data: { cause: diagnosis.cause, rule: diagnosis.rule, stage: snapshot.contacts },
      at: now,
    });

    const proposal = await proposer(snapshot, diagnosis, now);
    const [action] = await tx
      .insert(actions)
      .values({
        caseId,
        action: proposal.action,
        proposedBy: proposal.proposedBy,
        reason: proposal.reason,
        confidence: proposal.confidence,
        message: proposal.message ?? null,
        status: "proposed",
      })
      .returning({ id: actions.id });
    const actionId = action!.id;
    await setState(tx, caseId, "diagnosed", "proposed");
    await writeAudit(tx, {
      caseId,
      actor: proposal.proposedBy,
      kind: "proposed",
      data: {
        actionId,
        action: proposal.action,
        reason: proposal.reason,
        confidence: proposal.confidence,
        nextCheckAfterHours: proposal.nextCheckAfterHours,
        message: proposal.message ?? null,
        // 5.5: model name, prompt version and the exact input snapshot (absent for rules).
        model: proposal.meta?.model ?? null,
        promptVersion: proposal.meta?.promptVersion ?? null,
        inputSnapshot: proposal.meta?.input ?? null,
        modelMeta: proposal.meta
          ? {
              attempts: proposal.meta.attempts,
              rejected: proposal.meta.rejected,
              modelCause: proposal.meta.modelCause,
              fallback: proposal.meta.fallback,
              draft: proposal.meta.draft,
              usage: proposal.meta.usage,
            }
          : null,
      },
      at: now,
    });

    const decision = await gate(tx, deps, snapshot, proposal, policy, now);
    await tx
      .update(actions)
      .set({
        gateVerdict: decision.verdict,
        gateReasons: decision.reasons,
        policyVersion: decision.policyVersion,
      })
      .where(eq(actions.id, actionId));
    await writeAudit(tx, {
      caseId,
      actor: "gate",
      kind: "gated",
      data: {
        actionId,
        verdict: decision.verdict,
        decidedBy: decision.decidedBy,
        effect: decision.effect,
        reasons: decision.reasons,
        checks: decision.checks,
        policyVersion: decision.policyVersion,
      },
      at: now,
    });

    return applyDecision(tx, caseId, actionId, proposal, decision, now);
  });

  if (step.execute) {
    const executed = await executeAction(deps, step.execute, policy);
    return { ...executed, decision: step.decision };
  }
  deps.logger?.info({ caseId, outcome: step.outcome, detail: step.detail }, "case checked");
  return step;
}

async function gate(
  tx: Tx,
  deps: LoopDeps,
  s: CaseSnapshot,
  proposal: Proposal,
  policy: Policy,
  now: Date,
  approvedByHuman = false,
) {
  return evaluateGate({
    lane: s.lane,
    amountCents: s.amountCents,
    resolved: null, // payment and cancellation close the case through events before this point
    disputed: s.disputed,
    optedOut: s.optedOut,
    customerTimezone: s.customerTimezone,
    contactsOnCase: s.contacts,
    customerContactsLast7Days: s.customerContactsLast7Days,
    lastContactAt: s.lastContactAt,
    proposal,
    // Every outgoing message is linted against the case's own facts (5.8), whoever drafted it.
    messageLint: proposal.message ? lintMessage(proposal.message.body, messageFacts(s)) : undefined,
    redrafted: proposal.meta?.draft?.redrafted ?? false,
    approvedByHuman,
    systemPaused: await isSystemPaused(tx),
    enabledTools: enabledTools(s.lane),
    policy,
    now,
  });
}

async function applyDecision(
  tx: Tx,
  caseId: string,
  actionId: string,
  proposal: Proposal,
  decision: GateDecision,
  now: Date,
): Promise<CheckResult & { execute?: string }> {
  const effect = decision.effect;
  const setAction = (status: "blocked" | "held" | "approved" | "executed" | "cancelled") =>
    tx.update(actions).set({ status }).where(eq(actions.id, actionId));
  const reason = decision.reasons[0] ?? proposal.reason;

  switch (effect.kind) {
    case "close":
      await setAction("blocked");
      await closeCase(tx, caseId, effect.endState, reason, "gate", { at: now });
      return { caseId, outcome: "closed", detail: effect.endState, decision };
    case "escalate":
      await setAction("blocked");
      await closeCase(tx, caseId, "escalated", reason, "gate", { at: now });
      return { caseId, outcome: "closed", detail: "escalated", decision };
    case "stop":
      await setAction("blocked");
      await closeCase(tx, caseId, "stopped", reason, "gate", { at: now });
      return { caseId, outcome: "closed", detail: "stopped", decision };
    case "pause":
    case "retry_at": {
      const at = effect.kind === "retry_at" ? effect.at : new Date(now.getTime() + 15 * 60_000);
      await setAction(decision.verdict === "hold" ? "held" : "blocked");
      await setState(tx, caseId, "proposed", "awaiting");
      await scheduleCheck(tx, caseId, at, `gate rule ${decision.decidedBy}: ${reason}`);
      await writeAudit(tx, {
        caseId,
        actor: "gate",
        kind: "scheduled",
        data: { runAt: at.toISOString(), reason },
        at: now,
      });
      return { caseId, outcome: "deferred", detail: reason, decision };
    }
    case "approval":
    case "redraft": {
      // Rule-based drafts never fail lint; until 5.8 a redraft request is treated as a hold for a person.
      await setAction("held");
      await tx.insert(approvals).values({ actionId, status: "pending" });
      await setState(tx, caseId, "proposed", "approval");
      await writeAudit(tx, {
        caseId,
        actor: "gate",
        kind: "approval",
        data: { actionId, status: "pending", heldBy: decision.decidedBy, reason },
        at: now,
      });
      return { caseId, outcome: "held", detail: reason, decision };
    }
    case "proceed": {
      if (proposal.action === "escalate_to_human" || proposal.action === "stop") {
        await setAction("executed");
        await closeCase(
          tx,
          caseId,
          proposal.action === "stop" ? "stopped" : "escalated",
          proposal.reason,
          proposal.proposedBy,
          { at: now },
        );
        return { caseId, outcome: "closed", detail: proposal.action, decision };
      }
      if (isWaitAction(proposal.action as Action)) {
        const at = new Date(now.getTime() + proposal.nextCheckAfterHours * H);
        await tx
          .update(actions)
          .set({ status: "executed", executedAt: now, toolCall: { internal: proposal.action } })
          .where(eq(actions.id, actionId));
        await setState(tx, caseId, "proposed", "awaiting");
        await scheduleCheck(tx, caseId, at, proposal.reason);
        await writeAudit(tx, {
          caseId,
          actor: proposal.proposedBy,
          kind: "scheduled",
          data: { action: proposal.action, runAt: at.toISOString() },
          at: now,
        });
        return { caseId, outcome: "waiting", detail: proposal.action, decision };
      }
      await setAction("approved");
      return { caseId, outcome: "executed", execute: actionId, decision };
    }
  }
}

/** Approves or rejects a held action (used by the approval queue in 6.9, and by tests). */
export async function decideApproval(
  deps: LoopDeps,
  actionId: string,
  decision: { approve: boolean; by: string; note?: string; editedMessage?: Proposal["message"] },
): Promise<CheckResult> {
  const now = (deps.now ?? (() => new Date()))();
  const policy = await loadPolicy(deps.db, deps.mode);
  const step = await auditedTransaction(deps.db, async (tx): Promise<CheckResult & { execute?: string }> => {
    const [row] = await tx.select().from(actions).where(eq(actions.id, actionId)).for("update");
    if (!row) throw new Error(`action ${actionId} not found`);
    const c = await lockCase(tx, row.caseId);
    const [pending] = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.actionId, actionId), eq(approvals.status, "pending")))
      .for("update");
    if (!c || !pending || c.state !== "approval")
      return { caseId: row.caseId, outcome: "skipped", detail: "nothing pending for this action" };

    const status = !decision.approve ? "rejected" : decision.editedMessage ? "edited" : "approved";
    await tx
      .update(approvals)
      .set({
        status,
        decidedBy: decision.by,
        decidedAt: now,
        note: decision.note ?? null,
        editedMessage: decision.editedMessage ?? null,
      })
      .where(eq(approvals.id, pending.id));
    await writeAudit(tx, {
      caseId: row.caseId,
      actor: decision.by,
      kind: "approval",
      data: { actionId, status, note: decision.note ?? null, editedMessage: decision.editedMessage ?? null },
      at: now,
    });

    if (!decision.approve) {
      await tx.update(actions).set({ status: "cancelled" }).where(eq(actions.id, actionId));
      await closeCase(
        tx,
        row.caseId,
        "stopped",
        `rejected by ${decision.by}${decision.note ? `: ${decision.note}` : ""}`,
        decision.by,
        { at: now },
      );
      return { caseId: row.caseId, outcome: "closed", detail: "rejected" };
    }
    if (decision.editedMessage)
      await tx.update(actions).set({ message: decision.editedMessage }).where(eq(actions.id, actionId));

    // Re-gate with the approval recorded: stop conditions, kill switch, caps, spacing and hours still apply.
    const snapshot = (await loadSnapshot(tx, row.caseId, now))!;
    const proposal = {
      action: row.action as Action,
      confidence: row.confidence ?? 0,
      message: (decision.editedMessage ?? row.message) as Proposal["message"],
    };
    const regate = await gate(tx, deps, snapshot, proposal as Proposal, policy, now, true);
    await writeAudit(tx, {
      caseId: row.caseId,
      actor: "gate",
      kind: "gated",
      data: {
        actionId,
        verdict: regate.verdict,
        decidedBy: regate.decidedBy,
        reasons: regate.reasons,
        checks: regate.checks,
        afterApproval: true,
      },
      at: now,
    });
    if (regate.effect.kind === "proceed") {
      await tx.update(actions).set({ status: "approved" }).where(eq(actions.id, actionId));
      return { caseId: row.caseId, outcome: "executed", execute: actionId };
    }
    if (regate.effect.kind === "retry_at" || regate.effect.kind === "pause") {
      // Approved, but not now (for example outside contact hours): keep the approval and retry later.
      const at = regate.effect.kind === "retry_at" ? regate.effect.at : new Date(now.getTime() + 15 * 60_000);
      await setState(tx, row.caseId, "approval", "awaiting");
      await scheduleCheck(tx, row.caseId, at, `approved; ${regate.reasons[0]}`);
      return { caseId: row.caseId, outcome: "deferred", detail: regate.reasons[0] };
    }
    const end =
      regate.effect.kind === "close"
        ? regate.effect.endState
        : regate.effect.kind === "stop"
          ? "stopped"
          : "escalated";
    await closeCase(tx, row.caseId, end, regate.reasons[0] ?? "blocked after approval", "gate", { at: now });
    return { caseId: row.caseId, outcome: "closed", detail: end };
  });
  if (step.execute) return executeAction(deps, step.execute, policy);
  return step;
}

/**
 * Starts the live loop on a seeded batch: from now on its treatment cases are worked (control cases
 * never are), and each treatment case without a pending check gets one now.
 */
export async function startBatch(db: Database, batchId: string, now: Date = new Date()): Promise<number> {
  return auditedTransaction(db, async (tx) => {
    await tx
      .update(batches)
      .set({ startedAt: sql`coalesce(${batches.startedAt}, now())` })
      .where(eq(batches.id, batchId));
    const open = await tx
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.batchId, batchId), eq(cases.experimentGroup, "treatment"), isNull(cases.closedAt)));
    for (const c of open) await scheduleCheck(tx, c.id, now, "batch started");
    await writeAudit(tx, {
      caseId: null,
      actor: "operator",
      kind: "system",
      data: { startedBatch: batchId, treatmentCases: open.length },
    });
    return open.length;
  });
}

export { isContactAction };
