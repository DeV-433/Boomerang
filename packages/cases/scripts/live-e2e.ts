/**
 * Live end-to-end check of the Phase 4 loop against the real PayPal sandbox, on ONE new invoice.
 * Sandbox only, local database only. It never lists or touches other invoices, so a seeded demo
 * batch in the sandbox is safe.
 *
 *   npx tsx packages/cases/scripts/live-e2e.ts
 *
 * 1. creates and sends a backdated (overdue) sandbox invoice
 * 2. stores the overdue finding exactly as the poller would, and opens the case
 * 3. runs one live check: diagnose -> propose -> gate -> PayPal re-read -> cancel auto-reminders -> reminder
 * 4. the "customer" pays (record payment in the sandbox)
 * 5. stores PayPal's new status as the poller would; the case closes as recovered
 * 6. prints the audit trail and verifies its hash chain
 */
import { asc, eq } from "drizzle-orm";
import { verifyChain } from "@boomerang/audit";
import { createLogger, loadConfig, requireConfig } from "@boomerang/core";
import { auditLog, cases, customers, events, createDb } from "@boomerang/db";
import { createPayPal, getInvoice, recordPaymentForInvoice } from "@boomerang/paypal";
import { localTime } from "@boomerang/policy";
import { processPendingEvents } from "../src/events";
import { runDueJobs } from "../src/jobs";

const config = loadConfig();
if (config.PAYPAL_ENVIRONMENT !== "SANDBOX") throw new Error("sandbox only");
const logger = createLogger({ name: "live-e2e", level: "warn" });
const db = createDb(requireConfig(config, "DATABASE_URL"));
const { gateway } = createPayPal(config, { db: db.db, logger });
const run = `e2e-${Date.now()}`;
const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const step = (s: string) => console.log(`\n== ${s}`);

/** A customer time zone where it is currently Mon-Sat 10:00-16:59, so the gate's contact-hours rule passes now. */
function zoneInContactHours(now: Date): string {
  const zones = ["America/New_York", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Auckland"];
  const ok = zones.find((tz) => {
    const { hour, weekday } = localTime(now, tz);
    return weekday >= 1 && weekday <= 6 && hour >= 10 && hour < 17;
  });
  if (!ok) throw new Error("no listed time zone is in contact hours right now; try again later");
  return ok;
}

async function storePollEvent(invoice: Awaited<ReturnType<typeof getInvoice>>, type: string, id: string) {
  const payload = { id, event_type: type, resource_type: "invoices", resource: { invoice } };
  await db.db.insert(events).values({ paypalEventId: id, type, resourceType: "invoices", resourceId: invoice.id, payload, rawBody: JSON.stringify(payload), headers: {}, source: "poll" }).onConflictDoNothing();
  await processPendingEvents(db.db, { logger });
}

try {
  step("1. create and send a backdated sandbox invoice");
  const created = await gateway.callRest<{ id?: string; href?: string }>(
    "seeder",
    "create_invoice_with_terms",
    {
      method: "POST",
      path: "/v2/invoicing/invoices",
      body: {
        detail: { currency_code: "USD", invoice_date: day(20), reference: run, note: "Boomerang live end-to-end check", payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: day(6) } },
        invoicer: { email_address: requireConfig(config, "PAYPAL_SANDBOX_MERCHANT_EMAIL") },
        primary_recipients: [
          { billing_info: { name: { full_name: "Grace Hopper" }, email_address: `boomerang.${run}@example.com`, address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" } } },
        ],
        items: [{ name: "End-to-end check", quantity: "1", unit_amount: { currency_code: "USD", value: "64.00" } }],
      },
    },
    { idempotencyKey: `${run}:create` },
  );
  const invoiceId = created.data.id ?? created.data.href!.split("/").pop()!;
  await gateway.callTool("seeder", "send_invoice", { invoice_id: invoiceId, send_to_recipient: true }, { idempotencyKey: `${run}:send` });
  const sent = await getInvoice(gateway, invoiceId);
  console.log(`   ${invoiceId} status=${sent.status} due=${sent.detail.payment_term?.due_date}`);

  step("2. overdue finding stored as the poller would; case opener runs");
  await storePollEvent(sent, "BOOMERANG.INVOICE.OVERDUE", `POLL-OVERDUE-${invoiceId}`);
  const [opened] = await db.db.select().from(cases).where(eq(cases.paypalRef, invoiceId));
  const tz = zoneInContactHours(new Date());
  await db.db.update(customers).set({ timezone: tz }).where(eq(customers.id, opened!.customerId));
  console.log(`   case ${opened!.id} state=${opened!.state} amount=$${opened!.amountCents / 100} (customer zone ${tz}, inside contact hours now)`);

  step("3. one live check through the loop");
  const [result] = await runDueJobs({ db: db.db, gateway, mode: "live", logger }, { caseIds: [opened!.id] });
  const [afterSend] = await db.db.select().from(cases).where(eq(cases.id, opened!.id));
  console.log(`   outcome=${result?.outcome} detail=${result?.detail} -> state=${afterSend!.state} contacts=${afterSend!.contacts} next check ${afterSend!.nextCheckAt?.toISOString()}`);
  if (result?.outcome !== "executed") throw new Error(`expected a live reminder, got ${result?.outcome}: ${result?.detail}`);

  step("4. the customer pays (recorded in the sandbox)");
  await recordPaymentForInvoice(gateway, { invoiceId, amount: { currencyCode: "USD", value: "64.00" }, method: "PAYPAL", note: "e2e payment" }, `${run}:pay`, "seeder");
  const paid = await getInvoice(gateway, invoiceId);
  console.log(`   PayPal now reports ${paid.status}`);

  step("5. new status stored as the poller would; case closes");
  await storePollEvent(paid, "BOOMERANG.INVOICE.STATUS_CHANGED", `POLL-STATUS-${invoiceId}-${paid.status}`);
  const [closed] = await db.db.select().from(cases).where(eq(cases.id, opened!.id));
  console.log(`   state=${closed!.state} recovered=$${closed!.recoveredCents / 100} reason="${closed!.closeReason}"`);

  step("6. audit trail");
  const trail = await db.db.select().from(auditLog).where(eq(auditLog.caseId, opened!.id)).orderBy(asc(auditLog.id));
  for (const e of trail) {
    const d = e.data as Record<string, unknown>;
    const what = d.cause ?? d.action ?? d.verdict ?? d.tool ?? d.type ?? d.endState ?? "";
    console.log(`   #${e.id} ${e.kind.padEnd(15)} ${e.actor.padEnd(9)} ${String(what)}${d.idempotencyKey ? `  key=${d.idempotencyKey}` : ""}`);
  }
  const chain = await verifyChain(db.db, { fromId: trail[0]!.id });
  console.log(`   chain from #${trail[0]!.id}: ${chain.ok ? `verified (${chain.checked} entries)` : `BROKEN at ${chain.brokenAt}`}`);
  process.exitCode = closed!.state === "recovered" && chain.ok ? 0 : 1;
} finally {
  await db.close();
}
