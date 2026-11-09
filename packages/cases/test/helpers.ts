import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { cases, customers, events, type Database } from "@boomerang/db";
import {
  MemoryIdempotencyStore,
  PayPalGateway,
  PayPalHttpError,
  TokenManager,
  type FetchLike,
  type ToolRunner,
} from "@boomerang/paypal";

export interface FakePayPal {
  gateway: PayPalGateway;
  /** Every PayPal operation the code actually performed, in order. */
  calls: { tool: string; args: Record<string, unknown>; requestId?: string }[];
  /** Invoice status PayPal reports for get_invoice, per invoice id (default SENT). */
  invoiceStatus: Map<string, string>;
  /** Invoices list_invoices returns. */
  invoices: Record<string, unknown>[];
  /** get_invoice fails with this HTTP status for these invoice ids (outage or deleted invoice). */
  failGetInvoice: Map<string, number>;
}

/**
 * A real PayPalGateway (whitelist, schema checks, idempotency ledger, retries) over a fake PayPal,
 * so loop tests exercise the same path production does without touching the network.
 */
export function fakePayPal(): FakePayPal {
  const calls: FakePayPal["calls"] = [];
  const invoiceStatus = new Map<string, string>();
  const invoices: Record<string, unknown>[] = [];
  const failGetInvoice = new Map<string, number>();
  const runTool: ToolRunner = async (tool, args, options) => {
    const a = args as Record<string, unknown>;
    calls.push({ tool, args: a, requestId: options.requestId });
    const failWith = tool === "get_invoice" ? failGetInvoice.get(String(a.invoice_id)) : undefined;
    if (failWith)
      throw new PayPalHttpError(failWith, `{"name":"FAKE_${failWith}"}`, "fake-debug", "get_invoice");
    if (tool === "get_invoice")
      return {
        id: a.invoice_id,
        status: invoiceStatus.get(String(a.invoice_id)) ?? "SENT",
        detail: { currency_code: "USD" },
      };
    if (tool === "list_invoices") return { items: invoices, total_pages: 1 };
    return {};
  };
  const fetchFn: FetchLike = async (url, init) => {
    if (url.endsWith("/v1/oauth2/token"))
      return new Response(JSON.stringify({ access_token: "t", expires_in: 32400 }));
    calls.push({
      tool: `REST ${init?.method} ${new URL(url).pathname}`,
      args: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(JSON.stringify({ id: "CAP-1", status: "COMPLETED" }));
  };
  const tokens = new TokenManager({ clientId: "id", clientSecret: "s", environment: "SANDBOX" }, fetchFn);
  const gateway = new PayPalGateway({
    tokens,
    idempotency: new MemoryIdempotencyStore(),
    runTool,
    fetchFn,
    retry: { sleep: async () => {} },
  });
  return { gateway, calls, invoiceStatus, invoices, failGetInvoice };
}

export const tool = (fake: FakePayPal, name: string) => fake.calls.filter((c) => c.tool === name);

/** A valid-looking PayPal invoice id, unique per call. */
export function invoiceId(): string {
  const r = randomUUID().replace(/-/g, "").toUpperCase();
  return `INV2-${r.slice(0, 4)}-${r.slice(4, 8)}-${r.slice(8, 12)}-${r.slice(12, 16)}`;
}

/** Stores an event as the API would and returns its id. */
export async function storeEvent(
  db: Database,
  type: string,
  resource: unknown,
  options: { simulated?: boolean; source?: string } = {},
) {
  const id = `WH-TEST-${randomUUID()}`;
  const payload = { id, event_type: type, resource };
  await db.insert(events).values({
    paypalEventId: id,
    type,
    payload,
    rawBody: JSON.stringify(payload),
    headers: {},
    source: options.source ?? "webhook",
    simulated: options.simulated ?? false,
  });
  return id;
}

export function overdueInvoice(id: string, cents = 25_000, status = "SENT") {
  return {
    id,
    status,
    detail: { currency_code: "USD", payment_term: { due_date: "2026-10-30" } },
    primary_recipients: [
      {
        billing_info: {
          email_address: `${id.toLowerCase()}@example.com`,
          name: { full_name: "Ada Lovelace" },
        },
      },
    ],
    amount: { currency_code: "USD", value: (cents / 100).toFixed(2) },
    due_amount: { currency_code: "USD", value: (cents / 100).toFixed(2) },
  };
}

export async function caseByRef(db: Database, ref: string) {
  const [row] = await db.select().from(cases).where(eq(cases.paypalRef, ref));
  return row!;
}

export async function setCustomerTimezone(db: Database, customerId: string, timezone: string | null) {
  await db.update(customers).set({ timezone }).where(eq(customers.id, customerId));
}

/** Tuesday 2026-11-10 10:00 in New York: inside contact hours for a New York customer. */
export const TUESDAY_10AM_NY = new Date("2026-11-10T15:00:00Z");
export const hoursLater = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);
