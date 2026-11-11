import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { auditedTransaction, writeAudit } from "@boomerang/audit";
import type { Logger } from "@boomerang/core";
import { cases, customers, events, type Database } from "@boomerang/db";
import { CLOSED_UNPAID_STATUSES, PAID_STATUSES } from "./diagnose";
import { closeCase, scheduleCheck, type Tx } from "./store";

type EventRow = typeof events.$inferSelect;
type Money = { currency_code?: string; value?: string };

interface SubscriptionResource {
  id?: string;
  status?: string;
  subscriber?: {
    email_address?: string;
    payer_id?: string;
    name?: { given_name?: string; surname?: string };
  };
  billing_info?: {
    outstanding_balance?: Money;
    last_failed_payment?: { amount?: Money; reason_code?: string };
    failed_payments_count?: number;
  };
}

interface InvoiceResource {
  id?: string;
  status?: string;
  detail?: { currency_code?: string; invoice_number?: string; payment_term?: { due_date?: string } };
  primary_recipients?: { billing_info?: { email_address?: string; name?: { full_name?: string } } }[];
  amount?: Money;
  due_amount?: Money;
  payments?: { paid_amount?: Money };
}

const toCents = (value: string | undefined): number => Math.round(Number(value ?? "0") * 100);

interface Ctx {
  tx: Tx;
  event: EventRow;
  now: Date;
}

const resourceOf = <T>(event: EventRow): T => ((event.payload as { resource?: T }).resource ?? {}) as T;
const invoiceOf = (event: EventRow): InvoiceResource => {
  const r = resourceOf<{ invoice?: InvoiceResource } & InvoiceResource>(event);
  return r.invoice ?? r;
};

async function openCaseFor(tx: Tx, lane: "invoice" | "subscription", ref: string) {
  const [row] = await tx
    .select()
    .from(cases)
    .where(and(eq(cases.lane, lane), eq(cases.paypalRef, ref), isNull(cases.closedAt)));
  return row ?? null;
}

async function observed(ctx: Ctx, caseId: string, data: Record<string, unknown>) {
  await writeAudit(ctx.tx, {
    caseId,
    actor: ctx.event.simulated
      ? "simulator"
      : ctx.event.source === "poll"
        ? "poller"
        : ctx.event.source === "paypage"
          ? "customer:paypage"
          : ctx.event.source === "operator"
            ? "operator"
            : "paypal",
    kind: "event_received",
    data: {
      eventId: ctx.event.paypalEventId,
      type: ctx.event.type,
      storedEventId: ctx.event.id,
      simulated: ctx.event.simulated,
      ...data,
    },
    at: ctx.now,
  });
}

async function upsertCustomer(
  tx: Tx,
  c: { payerRef?: string | null; email?: string | null; name?: string | null; simulated: boolean },
): Promise<string> {
  if (c.payerRef) {
    const [row] = await tx
      .insert(customers)
      .values({
        paypalPayerRef: c.payerRef,
        email: c.email ?? null,
        name: c.name ?? null,
        simulated: c.simulated,
      })
      .onConflictDoUpdate({
        target: customers.paypalPayerRef,
        set: { email: sql`coalesce(excluded.email, ${customers.email})` },
      })
      .returning({ id: customers.id });
    return row!.id;
  }
  if (c.email) {
    const [existing] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.email, c.email))
      .limit(1);
    if (existing) return existing.id;
  }
  const [row] = await tx
    .insert(customers)
    .values({ email: c.email ?? null, name: c.name ?? null, simulated: c.simulated })
    .returning({ id: customers.id });
  return row!.id;
}

/** Inserts a case, or returns the open one if a concurrent processor won the race. */
async function insertCase(
  tx: Tx,
  values: typeof cases.$inferInsert,
): Promise<{ id: string; created: boolean }> {
  const [created] = await tx.insert(cases).values(values).onConflictDoNothing().returning({ id: cases.id });
  if (created) return { id: created.id, created: true };
  const existing = await openCaseFor(tx, values.lane, values.paypalRef);
  return { id: existing!.id, created: false };
}

// Subscription lane ------------------------------------------------------------------------------------

async function onSubscriptionPaymentFailed(ctx: Ctx): Promise<string | null> {
  const r = resourceOf<SubscriptionResource>(ctx.event);
  if (!r.id) return null;
  const outstanding = r.billing_info?.outstanding_balance;
  const money =
    outstanding && Number(outstanding.value) > 0 ? outstanding : r.billing_info?.last_failed_payment?.amount;
  const amountCents = toCents(money?.value);
  const facts = {
    paypalStatus: r.status ?? "ACTIVE",
    failedPayments: r.billing_info?.failed_payments_count ?? 1,
    lastFailureReason: r.billing_info?.last_failed_payment?.reason_code ?? null,
  };
  const open = await openCaseFor(ctx.tx, "subscription", r.id);
  let caseId: string;
  if (open) {
    caseId = open.id;
    await ctx.tx
      .update(cases)
      .set({ ...facts, amountCents: Math.max(open.amountCents, amountCents), updatedAt: sql`now()` })
      .where(eq(cases.id, caseId));
  } else {
    const customerId = await upsertCustomer(ctx.tx, {
      payerRef: r.subscriber?.payer_id,
      email: r.subscriber?.email_address,
      name: [r.subscriber?.name?.given_name, r.subscriber?.name?.surname].filter(Boolean).join(" ") || null,
      simulated: ctx.event.simulated,
    });
    caseId = (
      await insertCase(ctx.tx, {
        lane: "subscription",
        paypalRef: r.id,
        customerId,
        amountCents,
        currency: money?.currency_code ?? "USD",
        simulated: ctx.event.simulated,
        ...facts,
      })
    ).id;
  }
  await observed(ctx, caseId, { subscriptionId: r.id, amountCents, ...facts });
  await scheduleCheck(ctx.tx, caseId, ctx.now, "payment failed");
  return caseId;
}

async function onSubscriptionSuspended(ctx: Ctx): Promise<string | null> {
  const r = resourceOf<SubscriptionResource>(ctx.event);
  const open = r.id ? await openCaseFor(ctx.tx, "subscription", r.id) : null;
  if (!open) return null;
  const balance = toCents(r.billing_info?.outstanding_balance?.value);
  await ctx.tx
    .update(cases)
    .set({
      paypalStatus: "SUSPENDED",
      amountCents: balance > 0 ? balance : open.amountCents,
      updatedAt: sql`now()`,
    })
    .where(eq(cases.id, open.id));
  await observed(ctx, open.id, { paypalStatus: "SUSPENDED", outstandingCents: balance });
  await scheduleCheck(ctx.tx, open.id, ctx.now, "subscription suspended");
  return open.id;
}

async function onSubscriptionCancelled(ctx: Ctx): Promise<string | null> {
  const r = resourceOf<SubscriptionResource>(ctx.event);
  const open = r.id ? await openCaseFor(ctx.tx, "subscription", r.id) : null;
  if (!open) return null;
  // B12: an event without billing_info says nothing about the balance; keep what the case knows
  // instead of reading "nothing owing" into a missing field.
  const reported = r.billing_info?.outstanding_balance?.value;
  const balance = reported === undefined ? open.amountCents : toCents(reported);
  await ctx.tx
    .update(cases)
    .set({ paypalStatus: "CANCELLED", amountCents: balance, updatedAt: sql`now()` })
    .where(eq(cases.id, open.id));
  await observed(ctx, open.id, {
    paypalStatus: "CANCELLED",
    outstandingCents: balance,
    balanceReported: reported !== undefined,
  });
  if (balance === 0)
    await closeCase(ctx.tx, open.id, "stopped", "subscription cancelled with nothing owing", "paypal", {
      at: ctx.now,
    });
  else await scheduleCheck(ctx.tx, open.id, ctx.now, "subscription cancelled with a balance");
  return open.id;
}

/** A subscription payment went through. The sale's own id is resource.id; the subscription is billing_agreement_id. */
async function onSaleCompleted(ctx: Ctx): Promise<string | null> {
  const r = resourceOf<{ id?: string; billing_agreement_id?: string; amount?: { total?: string } }>(
    ctx.event,
  );
  const open = r.billing_agreement_id
    ? await openCaseFor(ctx.tx, "subscription", r.billing_agreement_id)
    : null;
  if (!open) return null;
  await observed(ctx, open.id, {
    saleId: r.id,
    subscriptionId: r.billing_agreement_id,
    paid: r.amount?.total ?? null,
  });
  await closeCase(ctx.tx, open.id, "recovered", "subscription payment completed", "paypal", {
    at: ctx.now,
  });
  return open.id;
}

// Invoice lane -----------------------------------------------------------------------------------------

/** Paid, partly paid, cancelled or refunded, from a PayPal webhook or from the poller. */
async function onInvoiceStatus(ctx: Ctx): Promise<string | null> {
  const inv = invoiceOf(ctx.event);
  const open = inv.id ? await openCaseFor(ctx.tx, "invoice", inv.id) : null;
  if (!open) return null;
  const status = (inv.status ?? "").toUpperCase();
  const due = inv.due_amount ? toCents(inv.due_amount.value) : null;
  await ctx.tx
    .update(cases)
    .set({
      paypalStatus: status || open.paypalStatus,
      ...(inv.detail?.invoice_number ? { invoiceNumber: inv.detail.invoice_number } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(cases.id, open.id));
  await observed(ctx, open.id, { invoiceId: inv.id, paypalStatus: status, dueCents: due });

  if (PAID_STATUSES.includes(status)) {
    // INVOICING.INVOICE.PAID also fires for a payment made and pending; PayPal reports that as PAYMENT_PENDING.
    // Recovered: any partial payments already received plus the rest (closeCase's default).
    await closeCase(ctx.tx, open.id, "recovered", `PayPal reports ${status}`, "paypal", { at: ctx.now });
  } else if (CLOSED_UNPAID_STATUSES.includes(status)) {
    await closeCase(ctx.tx, open.id, "stopped", `invoice ${status.toLowerCase()}`, "paypal", { at: ctx.now });
  } else if (status === "PARTIALLY_PAID" && due !== null && due < open.amountCents) {
    // B12: the part paid is recovered money; what is left is what reminders ask for.
    await ctx.tx
      .update(cases)
      .set({ amountCents: due, recoveredCents: open.recoveredCents + (open.amountCents - due) })
      .where(eq(cases.id, open.id));
  }
  return open.id;
}

/** From the poller: a sent invoice past its due date. Opens a case unless one is already open. */
async function onInvoiceOverdue(ctx: Ctx): Promise<string | null> {
  const inv = invoiceOf(ctx.event);
  if (!inv.id) return null;
  const open = await openCaseFor(ctx.tx, "invoice", inv.id);
  const facts = {
    paypalStatus: inv.status ?? "SENT",
    dueDate: inv.detail?.payment_term?.due_date ?? null,
    invoiceNumber: inv.detail?.invoice_number ?? null,
  };
  if (open) {
    await ctx.tx
      .update(cases)
      .set({ ...facts, updatedAt: sql`now()` })
      .where(eq(cases.id, open.id));
    await observed(ctx, open.id, { invoiceId: inv.id, ...facts, alreadyOpen: true });
    return open.id;
  }
  const recipient = inv.primary_recipients?.[0]?.billing_info;
  const customerId = await upsertCustomer(ctx.tx, {
    email: recipient?.email_address,
    name: recipient?.name?.full_name,
    simulated: false,
  });
  const money = inv.due_amount ?? inv.amount;
  const { id } = await insertCase(ctx.tx, {
    lane: "invoice",
    paypalRef: inv.id,
    customerId,
    amountCents: toCents(money?.value),
    currency: money?.currency_code ?? inv.detail?.currency_code ?? "USD",
    ...facts,
  });
  await observed(ctx, id, { invoiceId: inv.id, ...facts, amountCents: toCents(money?.value) });
  await scheduleCheck(ctx.tx, id, ctx.now, "invoice overdue");
  return id;
}

// Shared -----------------------------------------------------------------------------------------------

/**
 * A dispute stops all contact and goes to a person. PayPal's dispute resource identifies the
 * transaction, not the invoice: it carries the merchant's invoice number (detail.invoice_number,
 * for example "0042"), not PayPal's invoice id. B7: the case is found by its stored invoice number,
 * or by its PayPal id when the dispute carries that (custom field or a test event).
 */
async function onDispute(ctx: Ctx): Promise<string | null> {
  const r = resourceOf<{
    dispute_id?: string;
    disputed_transactions?: { invoice_number?: string; seller_transaction_id?: string; custom?: string }[];
  }>(ctx.event);
  const refs = (r.disputed_transactions ?? [])
    .flatMap((t) => [t.invoice_number, t.custom, t.seller_transaction_id])
    .filter((x): x is string => Boolean(x));
  if (refs.length === 0) return null;
  const [open] = await ctx.tx
    .select()
    .from(cases)
    .where(
      and(or(inArray(cases.paypalRef, refs), inArray(cases.invoiceNumber, refs)), isNull(cases.closedAt)),
    )
    .limit(1);
  if (!open) return null;
  await ctx.tx
    .update(cases)
    .set({ disputed: true, updatedAt: sql`now()` })
    .where(eq(cases.id, open.id));
  await observed(ctx, open.id, { disputeId: r.dispute_id ?? null });
  await scheduleCheck(ctx.tx, open.id, ctx.now, "dispute opened");
  return open.id;
}

/**
 * A customer reply that has already been classified (by the no-tools classifier in 5.9, by the
 * self-serve page in 7C, or by the simulator). Raw text is stored on the event, never passed on.
 */
async function onCustomerReply(ctx: Ctx): Promise<string | null> {
  const r = resourceOf<{
    paypal_ref?: string;
    lane?: "invoice" | "subscription";
    classification?: string;
    promise_date?: string;
  }>(ctx.event);
  if (!r.paypal_ref || !r.lane) return null;
  const open = await openCaseFor(ctx.tx, r.lane, r.paypal_ref);
  if (!open) return null;
  const label = r.classification ?? "other";
  if (label === "promise" && r.promise_date && /^\d{4}-\d{2}-\d{2}$/.test(r.promise_date)) {
    await ctx.tx.update(cases).set({ promiseDate: r.promise_date }).where(eq(cases.id, open.id));
  } else if (label === "dispute") {
    await ctx.tx.update(cases).set({ disputed: true }).where(eq(cases.id, open.id));
  } else if (label === "opt_out") {
    await ctx.tx
      .update(customers)
      .set({ optedOut: true, optedOutAt: ctx.now })
      .where(eq(customers.id, open.customerId));
  }
  await observed(ctx, open.id, { classification: label, promiseDate: r.promise_date ?? null });
  await scheduleCheck(ctx.tx, open.id, ctx.now, `customer reply: ${label}`);
  return open.id;
}

/**
 * 8.5: the customer says they updated their payment method (the pay page's "try again" button).
 * Records it on the subscription case and checks the case now, which proposes a retry of the balance.
 */
async function onPaymentUpdated(ctx: Ctx): Promise<string | null> {
  const r = resourceOf<{ paypal_ref?: string; lane?: string; source?: string }>(ctx.event);
  if (!r.paypal_ref || r.lane !== "subscription") return null;
  const open = await openCaseFor(ctx.tx, "subscription", r.paypal_ref);
  if (!open) return null;
  await ctx.tx.update(cases).set({ paymentUpdatedAt: ctx.now }).where(eq(cases.id, open.id));
  await observed(ctx, open.id, { paymentMethodUpdated: true, source: r.source ?? null });
  await scheduleCheck(ctx.tx, open.id, ctx.now, "customer updated their payment method");
  return open.id;
}

const HANDLERS: Record<string, (ctx: Ctx) => Promise<string | null>> = {
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED": onSubscriptionPaymentFailed,
  "BILLING.SUBSCRIPTION.SUSPENDED": onSubscriptionSuspended,
  "BILLING.SUBSCRIPTION.CANCELLED": onSubscriptionCancelled,
  "PAYMENT.SALE.COMPLETED": onSaleCompleted,
  "INVOICING.INVOICE.PAID": onInvoiceStatus,
  "INVOICING.INVOICE.CANCELLED": onInvoiceStatus,
  "INVOICING.INVOICE.REFUNDED": onInvoiceStatus,
  "INVOICING.INVOICE.UPDATED": onInvoiceStatus,
  "BOOMERANG.INVOICE.STATUS_CHANGED": onInvoiceStatus,
  "BOOMERANG.INVOICE.OVERDUE": onInvoiceOverdue,
  "BOOMERANG.CUSTOMER.REPLY": onCustomerReply,
  "BOOMERANG.CUSTOMER.PAYMENT_UPDATED": onPaymentUpdated,
  "CUSTOMER.DISPUTE.CREATED": onDispute,
  "CUSTOMER.DISPUTE.UPDATED": onDispute,
};

export const HANDLED_EVENT_TYPES = Object.keys(HANDLERS);

/**
 * Step 4.3: turns stored events into case changes, oldest first. Each event is claimed with
 * FOR UPDATE SKIP LOCKED, so the worker and the seeder can run this at the same time safely.
 * Types without a handler (for example INVOICING.INVOICE.CREATED) are marked processed with no case.
 */
export async function processPendingEvents(
  db: Database,
  options: { limit?: number; logger?: Logger; now?: () => Date } = {},
): Promise<number> {
  let processed = 0;
  const limit = options.limit ?? 500;
  for (;;) {
    const done = await auditedTransaction(db, async (tx) => {
      const [event] = await tx
        .select()
        .from(events)
        .where(
          and(
            isNull(events.processedAt),
            // A reply that arrived as raw text waits for the classifier (packages/agent) to label it.
            sql`not (${events.type} = 'BOOMERANG.CUSTOMER.REPLY' and ${events.payload}->'resource'->>'text' is not null and ${events.payload}->'resource'->>'classification' is null)`,
          ),
        )
        .orderBy(asc(events.receivedAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!event) return false;
      const handler = HANDLERS[event.type];
      const caseId = handler ? await handler({ tx, event, now: options.now?.() ?? new Date() }) : null;
      await tx
        .update(events)
        .set({ processedAt: sql`now()`, caseId: caseId ?? event.caseId })
        .where(eq(events.id, event.id));
      options.logger?.info(
        { eventId: event.paypalEventId, type: event.type, caseId, handled: Boolean(handler) },
        "event processed",
      );
      return true;
    });
    if (!done) break;
    if (++processed >= limit) break;
  }
  return processed;
}
