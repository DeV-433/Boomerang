/**
 * Live sandbox verification for BUILD_PLAN steps 2.4 to 2.7. Creates one real sandbox invoice and
 * walks it through read, remind, cancel-auto-reminder and record-payment, printing what PayPal did.
 * Usage: npx tsx scripts/sandbox-check.ts   (refuses to run outside the sandbox)
 */
import { createLogger, loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import {
  cancelInvoiceAutoReminder,
  createPayPal,
  getInvoice,
  listAllInvoices,
  recordPaymentForInvoice,
  sendInvoiceReminder,
  type PayPalInvoice,
} from "../src/index";

const config = loadConfig();
if (config.PAYPAL_ENVIRONMENT !== "SANDBOX") throw new Error("sandbox-check only runs against the sandbox");
const logger = createLogger({ name: "sandbox-check", level: "warn" });
const db = createDb(requireConfig(config, "DATABASE_URL"));
const { gateway } = createPayPal(config, { db: db.db, logger });
const run = `chk-${Date.now()}`;
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail: string) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}  ${detail}`);
};

try {
  // Setup through the seeder profile: create and send a real invoice.
  const created = await gateway.callTool<{ id?: string; href?: string; links?: { href: string }[] }>(
    "seeder",
    "create_invoice",
    {
      currency_code: "USD",
      invoicer_email_address: requireConfig(config, "PAYPAL_SANDBOX_MERCHANT_EMAIL"),
      note: `Boomerang Phase 2 check ${run}`,
      // PayPal blocks invoices to customers inside India, so the recipient is a US address without a
      // PayPal account (the seeder does the same). The India-registered sandbox customer cannot be invoiced.
      primary_recipients: [
        {
          billing_info: {
            email_address: `boomerang.check+${run}@example.com`,
            address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
          },
        },
      ],
      items: [{ name: "Phase 2 check", quantity: "1", unit_amount: { currency_code: "USD", value: "21.00" } }],
    },
    { idempotencyKey: `${run}:create` },
  );
  const href = created.data.href ?? created.data.links?.[0]?.href ?? "";
  const invoiceId = created.data.id ?? href.split("/").pop()!;
  console.log(`setup  created invoice ${invoiceId}`);
  await gateway.callTool("seeder", "send_invoice", { invoice_id: invoiceId, send_to_recipient: true }, { idempotencyKey: `${run}:send` });

  // 2.4 read-only wrappers return the invoice we created by hand.
  const before: PayPalInvoice = await getInvoice(gateway, invoiceId);
  check("2.4 getInvoice", before.id === invoiceId && before.status === "SENT", `status=${before.status} amount=${before.amount?.value}`);
  const all = await listAllInvoices(gateway);
  check("2.4 listInvoices", all.some((i) => i.id === invoiceId), `${all.length} invoices listed, ours included`);

  // 2.5 the same idempotency key sends once.
  const r1 = await sendInvoiceReminder(gateway, { invoiceId, note: "Boomerang reminder check" }, `${run}:remind:1`);
  const r2 = await sendInvoiceReminder(gateway, { invoiceId, note: "Boomerang reminder check" }, `${run}:remind:1`);
  check("2.5 sendInvoiceReminder", !r1.replayed && r2.replayed, `first sent to PayPal, second replayed from ledger`);

  // 2.6 PayPal's own reminders cancelled for this invoice.
  const cancel = await cancelInvoiceAutoReminder(gateway, invoiceId, `${run}:cancel-auto`);
  const afterCancel = await getInvoice(gateway, invoiceId);
  check("2.6 cancelInvoiceAutoReminder", !cancel.replayed, `PayPal accepted; invoice status=${afterCancel.status}`);
  console.log(`      invoice fields after cancel: ${JSON.stringify(afterCancel.configuration ?? null)}`);

  // 2.7 record the payment; the invoice flips to PAID and INVOICING.INVOICE.PAID is sent to the deployed API.
  await recordPaymentForInvoice(
    gateway,
    { invoiceId, amount: { currencyCode: "USD", value: "21.00" }, method: "PAYPAL", note: "Phase 2 check" },
    `${run}:pay`,
  );
  const paid = await getInvoice(gateway, invoiceId);
  // PayPal reports a payment recorded outside PayPal as MARKED_AS_PAID; it still sends INVOICING.INVOICE.PAID.
  check("2.7 recordPaymentForInvoice", paid.status === "PAID" || paid.status === "MARKED_AS_PAID", `status=${paid.status}`);
  console.log(`\nINVOICE_ID=${invoiceId}`);
} finally {
  await db.close();
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
