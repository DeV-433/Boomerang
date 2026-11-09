import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Logger } from "@boomerang/core";
import { cases, customers, events, type Database } from "@boomerang/db";

type EventRow = typeof events.$inferSelect;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

interface SubscriptionResource {
  id?: string;
  status?: string;
  subscriber?: { email_address?: string; payer_id?: string; name?: { given_name?: string; surname?: string } };
  billing_info?: {
    outstanding_balance?: { currency_code?: string; value?: string };
    last_failed_payment?: { amount?: { currency_code?: string; value?: string }; reason_code?: string };
    failed_payments_count?: number;
  };
}

const toCents = (value: string | undefined): number => Math.round(Number(value ?? "0") * 100);

/** Upserts the customer by PayPal payer id and returns its id. */
async function upsertCustomer(tx: Tx, resource: SubscriptionResource, simulated: boolean): Promise<string> {
  const payerRef = resource.subscriber?.payer_id ?? null;
  const name = [resource.subscriber?.name?.given_name, resource.subscriber?.name?.surname].filter(Boolean).join(" ") || null;
  const email = resource.subscriber?.email_address ?? null;
  if (payerRef) {
    const [row] = await tx
      .insert(customers)
      .values({ paypalPayerRef: payerRef, email, name, simulated })
      .onConflictDoUpdate({ target: customers.paypalPayerRef, set: { email: sql`coalesce(excluded.email, ${customers.email})` } })
      .returning({ id: customers.id });
    return row!.id;
  }
  const [row] = await tx.insert(customers).values({ email, name, simulated }).returning({ id: customers.id });
  return row!.id;
}

/**
 * BILLING.SUBSCRIPTION.PAYMENT.FAILED: open a subscription case for the amount at risk, or update
 * the open one. The amount is the outstanding balance when PayPal reports one, else the failed charge.
 */
async function onSubscriptionPaymentFailed(tx: Tx, event: EventRow): Promise<string | null> {
  const resource = ((event.payload as { resource?: SubscriptionResource }).resource ?? {}) as SubscriptionResource;
  if (!resource.id) return null;
  const outstanding = resource.billing_info?.outstanding_balance;
  const failed = resource.billing_info?.last_failed_payment?.amount;
  const money = outstanding && Number(outstanding.value) > 0 ? outstanding : failed;
  const amountCents = toCents(money?.value);
  const currency = money?.currency_code ?? "USD";

  const [open] = await tx
    .select({ id: cases.id, amountCents: cases.amountCents })
    .from(cases)
    .where(and(eq(cases.lane, "subscription"), eq(cases.paypalRef, resource.id), isNull(cases.closedAt)));
  if (open) {
    if (amountCents > open.amountCents) {
      await tx.update(cases).set({ amountCents, updatedAt: sql`now()` }).where(eq(cases.id, open.id));
    }
    return open.id;
  }
  const customerId = await upsertCustomer(tx, resource, event.simulated);
  const [created] = await tx
    .insert(cases)
    .values({ lane: "subscription", paypalRef: resource.id, customerId, amountCents, currency, simulated: event.simulated })
    .onConflictDoNothing()
    .returning({ id: cases.id });
  if (created) return created.id;
  // Lost a race with another processor: the open case now exists.
  const [winner] = await tx
    .select({ id: cases.id })
    .from(cases)
    .where(and(eq(cases.lane, "subscription"), eq(cases.paypalRef, resource.id), isNull(cases.closedAt)));
  return winner?.id ?? null;
}

/** Event types this module handles so far. Step 4.3 adds paid, cancelled, suspended and dispute events. */
const HANDLERS: Record<string, (tx: Tx, event: EventRow) => Promise<string | null>> = {
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED": onSubscriptionPaymentFailed,
};

export const HANDLED_EVENT_TYPES = Object.keys(HANDLERS);

/**
 * Processes stored events that have a handler, oldest first. Each event is claimed with
 * FOR UPDATE SKIP LOCKED, so the worker and the seeder can run this at the same time safely.
 * Event types without a handler yet are left unprocessed for later phases.
 */
export async function processPendingEvents(db: Database, options: { limit?: number; logger?: Logger } = {}): Promise<number> {
  let processed = 0;
  const limit = options.limit ?? 500;
  for (;;) {
    const done = await db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(events)
        .where(and(isNull(events.processedAt), inArray(events.type, HANDLED_EVENT_TYPES)))
        .orderBy(asc(events.receivedAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!event) return false;
      const caseId = await HANDLERS[event.type]!(tx, event);
      await tx.update(events).set({ processedAt: sql`now()`, caseId }).where(eq(events.id, event.id));
      options.logger?.info({ eventId: event.paypalEventId, type: event.type, caseId }, "event processed");
      return true;
    });
    if (!done) break;
    if (++processed >= limit) break;
  }
  return processed;
}
