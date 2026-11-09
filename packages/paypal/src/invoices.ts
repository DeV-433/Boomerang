import type { CallResult, PayPalGateway } from "./gateway";

/** The fields of a PayPal invoice Boomerang reads. PayPal returns more; extra fields pass through. */
export interface PayPalInvoice {
  id: string;
  status: string;
  detail: {
    invoice_number?: string;
    currency_code: string;
    payment_term?: { due_date?: string; term_type?: string };
    metadata?: { create_time?: string; last_update_time?: string };
  };
  primary_recipients?: { billing_info?: { email_address?: string; name?: { full_name?: string } } }[];
  amount?: { currency_code: string; value: string };
  due_amount?: { currency_code: string; value: string };
  payments?: { paid_amount?: { currency_code: string; value: string } };
  [key: string]: unknown;
}

export interface InvoiceList {
  items?: PayPalInvoice[];
  total_items?: number;
  total_pages?: number;
}

const PROFILE = "invoice" as const;

/** 2.4: one page of the merchant's invoices (read-only). */
export async function listInvoices(gw: PayPalGateway, opts: { page?: number; pageSize?: number } = {}): Promise<InvoiceList> {
  const { data } = await gw.callTool<InvoiceList>(PROFILE, "list_invoices", {
    page: opts.page ?? 1,
    page_size: opts.pageSize ?? 100,
    total_required: true,
  });
  return data;
}

/** Every invoice, following pages until PayPal reports none left. Used by the overdue poller (4.4). */
export async function listAllInvoices(gw: PayPalGateway, pageSize = 100): Promise<PayPalInvoice[]> {
  const all: PayPalInvoice[] = [];
  for (let page = 1; page <= 1000; page++) {
    const { items = [], total_pages } = await listInvoices(gw, { page, pageSize });
    all.push(...items);
    if (items.length < pageSize || (total_pages !== undefined && page >= total_pages)) break;
  }
  return all;
}

/** 2.4: one invoice by id (read-only). */
export async function getInvoice(gw: PayPalGateway, invoiceId: string): Promise<PayPalInvoice> {
  const { data } = await gw.callTool<PayPalInvoice>(PROFILE, "get_invoice", { invoice_id: invoiceId });
  return data;
}

/** 2.5: sends a reminder for a sent, unpaid invoice. The same key never sends twice. */
export async function sendInvoiceReminder(
  gw: PayPalGateway,
  input: { invoiceId: string; subject?: string; note?: string },
  idempotencyKey: string,
): Promise<CallResult<unknown>> {
  return gw.callTool(
    PROFILE,
    "send_invoice_reminder",
    {
      invoice_id: input.invoiceId,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.note ? { note: input.note } : {}),
    },
    { idempotencyKey },
  );
}

/** 2.6: stops PayPal's own automatic reminders, so the customer is not contacted by both systems. */
export async function cancelInvoiceAutoReminder(
  gw: PayPalGateway,
  invoiceId: string,
  idempotencyKey: string,
): Promise<CallResult<unknown>> {
  return gw.callTool(PROFILE, "cancel_invoice_auto_reminder", { invoice_id: invoiceId }, { idempotencyKey });
}

export type PaymentMethod =
  | "BANK_TRANSFER"
  | "CASH"
  | "CHECK"
  | "CREDIT_CARD"
  | "DEBIT_CARD"
  | "PAYPAL"
  | "WIRE_TRANSFER"
  | "OTHER";

/**
 * 2.7: records a payment made outside PayPal (marks the invoice paid or partly paid).
 * Used by the simulator to stand in for a customer who pays, which fires INVOICING.INVOICE.PAID.
 */
export async function recordPaymentForInvoice(
  gw: PayPalGateway,
  input: {
    invoiceId: string;
    amount: { currencyCode: string; value: string };
    method: PaymentMethod;
    /** yyyy-MM-dd; defaults to today (UTC). */
    paymentDate?: string;
    note?: string;
  },
  idempotencyKey: string,
  profile: "invoice" | "seeder" = PROFILE,
): Promise<CallResult<{ payment_id?: string }>> {
  return gw.callTool(
    profile,
    "record_payment_for_invoice",
    {
      invoice_id: input.invoiceId,
      method: input.method,
      payment_date: input.paymentDate ?? new Date().toISOString().slice(0, 10),
      amount: { currency_code: input.amount.currencyCode, value: input.amount.value },
      ...(input.note ? { note: input.note } : {}),
    },
    { idempotencyKey },
  );
}
