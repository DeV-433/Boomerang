import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Logger } from "@boomerang/core";
import { cases, events, type Database } from "@boomerang/db";
import { listAllInvoices, type PayPalGateway, type PayPalInvoice } from "@boomerang/paypal";
import { CLOSED_UNPAID_STATUSES, PAID_STATUSES } from "./diagnose";
import { processPendingEvents } from "./events";

/** Invoice statuses that still owe money. */
export const OPEN_INVOICE_STATUSES = ["SENT", "UNPAID", "PARTIALLY_PAID"];

/** Today's date (yyyy-MM-dd) in the merchant's time zone; due dates are calendar dates. */
export function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export interface PollResult {
  listed: number;
  overdue: number;
  statusChanges: number;
  eventsStored: number;
  processed: number;
}

/**
 * Step 4.4: PayPal has no "invoice overdue" webhook, so the worker lists invoices and compares due
 * dates. Findings are stored as events (BOOMERANG.INVOICE.OVERDUE with a fixed id per invoice, so
 * repeat polls store nothing new) and processed by the same case opener as webhooks. The poll also
 * catches paid or cancelled invoices whose webhook was missed.
 */
export async function pollInvoices(deps: { db: Database; gateway: PayPalGateway; merchantTimezone: string; now?: () => Date; logger?: Logger }): Promise<PollResult> {
  const now = deps.now?.() ?? new Date();
  const today = todayIn(deps.merchantTimezone, now);
  const invoices = await listAllInvoices(deps.gateway);

  const overdue = invoices.filter((i) => OPEN_INVOICE_STATUSES.includes(i.status) && (i.detail?.payment_term?.due_date ?? "9999-12-31") < today);
  const settled = invoices.filter((i) => [...PAID_STATUSES, ...CLOSED_UNPAID_STATUSES].includes(i.status));
  const openRefs = settled.length
    ? new Set(
        (
          await deps.db
            .select({ ref: cases.paypalRef })
            .from(cases)
            .where(and(eq(cases.lane, "invoice"), isNull(cases.closedAt), inArray(cases.paypalRef, settled.map((i) => i.id))))
        ).map((r) => r.ref),
      )
    : new Set<string>();
  const changed = settled.filter((i) => openRefs.has(i.id));

  const toEvent = (invoice: PayPalInvoice, type: string, id: string) => {
    const payload = { id, event_type: type, resource_type: "invoices", create_time: now.toISOString(), resource: { invoice } };
    return { paypalEventId: id, type, resourceType: "invoices", resourceId: invoice.id, payload, rawBody: JSON.stringify(payload), headers: {}, source: "poll" };
  };
  const rows = [
    ...overdue.map((i) => toEvent(i, "BOOMERANG.INVOICE.OVERDUE", `POLL-OVERDUE-${i.id}`)),
    ...changed.map((i) => toEvent(i, "BOOMERANG.INVOICE.STATUS_CHANGED", `POLL-STATUS-${i.id}-${i.status}`)),
  ];
  let stored = 0;
  for (let k = 0; k < rows.length; k += 200) {
    const inserted = await deps.db.insert(events).values(rows.slice(k, k + 200)).onConflictDoNothing({ target: events.paypalEventId }).returning({ id: events.id });
    stored += inserted.length;
  }
  const processed = await processPendingEvents(deps.db, { limit: 10_000, logger: deps.logger, now: deps.now });
  const result = { listed: invoices.length, overdue: overdue.length, statusChanges: changed.length, eventsStored: stored, processed };
  deps.logger?.info(result, "invoice poll");
  return result;
}
