import { eq, sql } from "drizzle-orm";
import { auditedTransaction, writeAudit } from "@boomerang/audit";
import { canTransition, isContactAction, isEndState, type Action, type Proposal } from "@boomerang/core";
import { actions, cases } from "@boomerang/db";
import {
  cancelInvoiceAutoReminder,
  captureSubscriptionBalance,
  getInvoice,
  PayPalHttpError,
  sendInvoiceReminder,
} from "@boomerang/paypal";
import type { Policy } from "@boomerang/policy";
import { CLOSED_UNPAID_STATUSES, PAID_STATUSES } from "./diagnose";
import type { CheckResult, LoopDeps } from "./loop";
import { closeCase, isSystemPaused, lockCase, scheduleCheck, setState } from "./store";

const H = 3_600_000;
/** Retry a failed PayPal call after this long. */
const FAILURE_RETRY_MS = H;

/** Stable per case, action and stage: a retry of the same step can never send twice. */
export function idempotencyKey(caseId: string, action: string, stage: number): string {
  return `${caseId}:${action}:${stage}`;
}

/**
 * Steps 4.12 and 4.13: executes an action the gate allowed (status "approved").
 *
 * Right before the call it re-reads the case (a paid or dispute event may have been processed
 * since the gate ran) and, for invoices, re-reads the invoice from PayPal. Paid always overrides:
 * if either says the money arrived, nothing is sent and the case closes as recovered.
 */
export const RECHECK_RETRY_MINUTES = 15;

/**
 * The pre-execution read failed, so nothing is sent. PayPal saying the invoice does not exist (404)
 * is final: the case stops. Anything else (outage, timeout) is treated as temporary: the action is
 * marked failed and the case checked again shortly, through the gate (and, if needed, a person) again.
 * Without this an approved action would be left half-done with no check scheduled.
 */
async function recheckFailed(
  deps: LoopDeps,
  f: { actionId: string; caseId: string; now: Date; error: unknown },
): Promise<CheckResult> {
  const status = f.error instanceof PayPalHttpError ? f.error.status : null;
  const message = f.error instanceof Error ? f.error.message : String(f.error);
  const gone = status === 404;
  const retryAt = new Date(f.now.getTime() + RECHECK_RETRY_MINUTES * 60_000);
  deps.logger?.warn(
    { caseId: f.caseId, actionId: f.actionId, status, err: message },
    "pre-execution re-check failed; nothing sent",
  );
  await auditedTransaction(deps.db, async (tx) => {
    const c = await lockCase(tx, f.caseId);
    await tx.update(actions).set({ status: "failed" }).where(eq(actions.id, f.actionId));
    await writeAudit(tx, {
      caseId: f.caseId,
      actor: "executor",
      kind: "observed",
      data: {
        actionId: f.actionId,
        source: "pre-execution re-check",
        failed: true,
        status,
        error: message.slice(0, 300),
      },
      at: f.now,
    });
    if (!c || isEndState(c.state)) return;
    if (gone) {
      await closeCase(
        tx,
        f.caseId,
        "stopped",
        "PayPal no longer has this invoice (404 at execution time); nothing sent",
        "executor",
        { at: f.now },
      );
      return;
    }
    if (c.state !== "awaiting" && canTransition(c.state, "awaiting"))
      await setState(tx, f.caseId, c.state, "awaiting");
    await scheduleCheck(tx, f.caseId, retryAt, "PayPal re-check failed; trying again");
  });
  return gone
    ? { caseId: f.caseId, outcome: "closed", detail: "PayPal no longer has this invoice; nothing sent" }
    : {
        caseId: f.caseId,
        outcome: "deferred",
        detail: `could not re-check the invoice with PayPal; nothing sent, checking again in ${RECHECK_RETRY_MINUTES} minutes`,
      };
}

export async function executeAction(deps: LoopDeps, actionId: string, policy: Policy): Promise<CheckResult> {
  const now = (deps.now ?? (() => new Date()))();
  const [row] = await deps.db.select().from(actions).where(eq(actions.id, actionId));
  if (!row) throw new Error(`action ${actionId} not found`);
  const caseId = row.caseId;

  // 4.13, part 1: the case as it stands now.
  const [current] = await deps.db.select().from(cases).where(eq(cases.id, caseId));
  if (!current || isEndState(current.state) || row.status !== "approved") {
    await deps.db.update(actions).set({ status: "cancelled" }).where(eq(actions.id, actionId));
    await writeAudit(deps.db, {
      caseId,
      actor: "executor",
      kind: "observed",
      data: { actionId, cancelled: true, reason: `case is ${current?.state ?? "missing"} at execution time` },
      at: now,
    });
    return { caseId, outcome: "cancelled", detail: `case is ${current?.state} at execution time` };
  }

  // 6.11: the global pause wins even over an action the gate passed a moment ago.
  if (await isSystemPaused(deps.db)) {
    const retryAt = new Date(now.getTime() + RECHECK_RETRY_MINUTES * 60_000);
    await auditedTransaction(deps.db, async (tx) => {
      const c = await lockCase(tx, caseId);
      await tx.update(actions).set({ status: "cancelled" }).where(eq(actions.id, actionId));
      await writeAudit(tx, {
        caseId,
        actor: "executor",
        kind: "observed",
        data: { actionId, cancelled: true, reason: "the operator paused all activity at execution time" },
        at: now,
      });
      if (!c || isEndState(c.state)) return;
      if (c.state !== "awaiting" && canTransition(c.state, "awaiting"))
        await setState(tx, caseId, c.state, "awaiting");
      await scheduleCheck(tx, caseId, retryAt, "system paused at execution time");
    });
    return { caseId, outcome: "deferred", detail: "the operator paused all activity; nothing sent" };
  }

  // 4.13, part 2: the invoice as PayPal sees it now. Nothing is sent unless this read succeeds.
  if (current.lane === "invoice" && deps.gateway) {
    let invoice: Awaited<ReturnType<typeof getInvoice>>;
    try {
      invoice = await getInvoice(deps.gateway, current.paypalRef);
    } catch (error) {
      return recheckFailed(deps, { actionId, caseId, now, error });
    }
    const status = invoice.status?.toUpperCase();
    if (PAID_STATUSES.includes(status) || CLOSED_UNPAID_STATUSES.includes(status)) {
      await auditedTransaction(deps.db, async (tx) => {
        await writeAudit(tx, {
          caseId,
          actor: "executor",
          kind: "observed",
          data: { actionId, source: "pre-execution re-check", paypalStatus: status },
          at: now,
        });
        await tx.update(cases).set({ paypalStatus: status }).where(eq(cases.id, caseId));
        await closeCase(
          tx,
          caseId,
          PAID_STATUSES.includes(status) ? "recovered" : "stopped",
          `PayPal reports ${status} at execution time; nothing sent`,
          "executor",
          { at: now },
        );
      });
      return { caseId, outcome: "cancelled", detail: `PayPal reports ${status}; nothing sent` };
    }
  }

  const action = row.action as Action;
  const message = row.message as Proposal["message"] | null;
  const stage = current.contacts;
  const key = idempotencyKey(caseId, action, stage);
  const nextCheckHours = action === "request_balance_capture" ? 24 : 72;

  // Dry run: the agent only suggests. Record what would have been called and move on.
  if (policy.mode === "dry_run" || !deps.gateway) {
    const wouldCall = describeCall(action, current.paypalRef, message, current.amountCents, current.currency);
    await auditedTransaction(deps.db, async (tx) => {
      const c = await lockCase(tx, caseId);
      if (!c || isEndState(c.state)) return;
      await tx
        .update(actions)
        .set({
          status: "executed",
          executedAt: now,
          idempotencyKey: key,
          toolCall: { dryRun: true, ...wouldCall },
        })
        .where(eq(actions.id, actionId));
      await setState(tx, caseId, c.state, "executed");
      await setState(tx, caseId, "executed", "awaiting");
      await scheduleCheck(tx, caseId, new Date(now.getTime() + nextCheckHours * H), "dry run: next check");
      await writeAudit(tx, {
        caseId,
        actor: "executor",
        kind: "executed",
        data: { actionId, dryRun: true, ...wouldCall, idempotencyKey: key },
        at: now,
      });
    });
    return { caseId, outcome: "dry_run", detail: wouldCall.tool ?? wouldCall.channel };
  }

  // Live: call PayPal through the whitelisted gateway with an idempotency key.
  let toolCall: Record<string, unknown>;
  let toolResponse: unknown = null;
  try {
    if (current.lane === "invoice" && current.contacts === 0) {
      // First contact by Boomerang: stop PayPal's own automatic reminders so the customer hears from one system.
      await cancelInvoiceAutoReminder(deps.gateway, current.paypalRef, `${caseId}:cancel_auto_reminder`);
    }
    if (action === "send_reminder" || action === "offer_payment_plan") {
      const result = await sendInvoiceReminder(
        deps.gateway,
        { invoiceId: current.paypalRef, subject: message?.subject, note: message?.body },
        key,
      );
      toolCall = { tool: "send_invoice_reminder", invoiceId: current.paypalRef, subject: message?.subject };
      toolResponse = { replayed: result.replayed, data: result.data ?? null };
    } else if (action === "request_balance_capture") {
      const amount = { currencyCode: current.currency, value: (current.amountCents / 100).toFixed(2) };
      const result = await captureSubscriptionBalance(
        deps.gateway,
        { subscriptionId: current.paypalRef, amount, note: "Outstanding balance" },
        key,
      );
      toolCall = { tool: "capture_subscription_balance", subscriptionId: current.paypalRef, amount };
      toolResponse = { replayed: result.replayed, data: result.data ?? null };
    } else if (action === "send_update_payment_message") {
      // PayPal has no tool to message a subscriber, and the project sends no real email (decision 0.6).
      toolCall = { channel: "log", subject: message?.subject, body: message?.body };
    } else {
      throw new Error(`executor has no mapping for action ${action}`);
    }
  } catch (error) {
    const e = error as { message?: string; status?: number | null; debugId?: string | null; body?: string };
    await auditedTransaction(deps.db, async (tx) => {
      const c = await lockCase(tx, caseId);
      await tx
        .update(actions)
        .set({
          status: "failed",
          idempotencyKey: key,
          toolResponse: { error: e.message, status: e.status ?? null, debugId: e.debugId ?? null },
        })
        .where(eq(actions.id, actionId));
      await writeAudit(tx, {
        caseId,
        actor: "executor",
        kind: "executed",
        data: {
          actionId,
          failed: true,
          error: e.message,
          status: e.status ?? null,
          debugId: e.debugId ?? null,
          idempotencyKey: key,
        },
        at: now,
      });
      if (c && !isEndState(c.state)) {
        await setState(tx, caseId, c.state, "awaiting");
        await scheduleCheck(
          tx,
          caseId,
          new Date(now.getTime() + FAILURE_RETRY_MS),
          `PayPal call failed: ${e.message}`,
        );
      }
    });
    deps.logger?.warn({ caseId, action, err: e.message }, "action failed");
    return { caseId, outcome: "failed", detail: e.message };
  }

  await auditedTransaction(deps.db, async (tx) => {
    const c = await lockCase(tx, caseId);
    if (!c) return;
    const contact = isContactAction(action);
    await tx
      .update(actions)
      .set({ status: "executed", executedAt: now, idempotencyKey: key, toolCall, toolResponse })
      .where(eq(actions.id, actionId));
    await writeAudit(tx, {
      caseId,
      actor: "executor",
      kind: "executed",
      data: { actionId, ...toolCall, response: toolResponse, idempotencyKey: key },
      at: now,
    });
    if (isEndState(c.state)) return; // paid while the call was in flight: the payment wins, the record stays
    await setState(
      tx,
      caseId,
      c.state,
      "executed",
      contact
        ? { contacts: sql`${cases.contacts} + 1`, stage: sql`${cases.stage} + 1`, lastContactAt: now }
        : {},
    );
    await setState(tx, caseId, "executed", "awaiting");
    await scheduleCheck(
      tx,
      caseId,
      new Date(now.getTime() + nextCheckHours * H),
      `next check after ${action}`,
    );
  });
  deps.logger?.info({ caseId, action, key }, "action executed");
  return { caseId, outcome: "executed", detail: action };
}

function describeCall(
  action: Action,
  ref: string,
  message: Proposal["message"] | null,
  amountCents: number,
  currency: string,
) {
  if (action === "send_reminder" || action === "offer_payment_plan")
    return { tool: "send_invoice_reminder", invoiceId: ref, subject: message?.subject, note: message?.body };
  if (action === "request_balance_capture")
    return {
      tool: "capture_subscription_balance",
      subscriptionId: ref,
      amount: { currencyCode: currency, value: (amountCents / 100).toFixed(2) },
    };
  return { channel: "log", subject: message?.subject, body: message?.body };
}
