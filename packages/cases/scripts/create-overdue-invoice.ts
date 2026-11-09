/**
 * Sandbox helper: creates and sends ONE backdated (overdue) invoice to a US example.com recipient, so
 * the deployed poller opens an organic case for it. Used to check the approval queue end to end (6.10):
 * an amount above the approval limit ($2,000) is held for a person.
 *   npx tsx packages/cases/scripts/create-overdue-invoice.ts [amountDollars=4500]
 * Refuses to run outside the PayPal sandbox. Does not touch any case table.
 */
import { randomUUID } from "node:crypto";
import { createLogger, loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import { createPayPal, getInvoice } from "@boomerang/paypal";

const config = loadConfig();
if (config.PAYPAL_ENVIRONMENT !== "SANDBOX") throw new Error("sandbox only");
const amount = Number(process.argv[2] ?? 4500);
if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000)
  throw new Error("amount must be between 0 and 10000 dollars");

const logger = createLogger({ name: "create-overdue-invoice", level: "warn" });
const db = createDb(requireConfig(config, "DATABASE_URL"), { max: 2 });
const { gateway } = createPayPal(config, { db: db.db, logger });
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const run = `approval-${randomUUID().slice(0, 8)}`;

try {
  const created = await gateway.callRest<{ id?: string; href?: string }>(
    "seeder",
    "create_invoice_with_terms",
    {
      method: "POST",
      path: "/v2/invoicing/invoices",
      body: {
        detail: {
          currency_code: "USD",
          invoice_date: day(20),
          reference: run,
          note: "Boomerang approval-queue check",
          payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: day(6) },
        },
        invoicer: { email_address: requireConfig(config, "PAYPAL_SANDBOX_MERCHANT_EMAIL") },
        primary_recipients: [
          {
            billing_info: {
              name: { full_name: "Katherine Johnson" },
              email_address: `boomerang.${run}@example.com`,
              address: {
                address_line_1: "1 Main St",
                admin_area_2: "San Jose",
                admin_area_1: "CA",
                postal_code: "95131",
                country_code: "US",
              },
            },
          },
        ],
        items: [
          {
            name: "Annual service plan",
            quantity: "1",
            unit_amount: { currency_code: "USD", value: amount.toFixed(2) },
          },
        ],
      },
    },
    { idempotencyKey: `${run}:create` },
  );
  const invoiceId = created.data.id ?? created.data.href!.split("/").pop()!;
  await gateway.callTool(
    "seeder",
    "send_invoice",
    { invoice_id: invoiceId, send_to_recipient: true },
    { idempotencyKey: `${run}:send` },
  );
  const sent = await getInvoice(gateway, invoiceId);
  console.log(
    JSON.stringify({
      invoiceId,
      status: sent.status,
      due: sent.detail.payment_term?.due_date,
      amount: sent.amount?.value,
    }),
  );
} finally {
  await db.close();
}
