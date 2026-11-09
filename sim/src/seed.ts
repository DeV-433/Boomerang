import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { processPendingEvents } from "@boomerang/cases";
import type { Logger } from "@boomerang/core";
import { batches, cases, customers, simProfiles, type Database } from "@boomerang/db";
import type { PayPalGateway } from "@boomerang/paypal";
import { assignArms } from "./assign";
import type { SimConfig } from "./config";
import { planBatch, type PlannedCase } from "./generate";
import { injectSubscriptionFailure, type EventPoster } from "./inject";
import { Rng } from "./rng";

export interface SeedOptions {
  db: Database;
  config: SimConfig;
  seed: string;
  size?: number;
  /** "sandbox": real PayPal invoices. "offline": simulated invoice ids, no PayPal calls (tests, demo fallback). */
  mode: "sandbox" | "offline";
  gateway?: PayPalGateway;
  merchantEmail?: string;
  /** Posts signed simulated events to the API (subscription failures go through the real API path). */
  poster: EventPoster;
  simSecret: string;
  concurrency?: number;
  logger?: Logger;
  now?: Date;
}

export interface SeedSummary {
  batchId: string;
  invoices: number;
  subscriptions: number;
  control: number;
  treatment: number;
  atRiskCents: number;
}

/** Runs `fn` over items with at most `limit` in flight. */
async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/** Creates a real, backdated, sent sandbox invoice and returns its id. Idempotent per seed and index. */
async function createSandboxInvoice(gateway: PayPalGateway, merchantEmail: string, planned: PlannedCase, seed: string): Promise<string> {
  const inv = planned.invoice!;
  const key = `seed:${seed}:${planned.profile.batchIndex}`;
  const created = await gateway.callRest<{ id?: string; href?: string }>(
    "seeder",
    "create_invoice_with_terms",
    {
      method: "POST",
      path: "/v2/invoicing/invoices",
      body: {
        detail: {
          currency_code: planned.currency,
          invoice_date: inv.invoiceDate,
          reference: key,
          note: "Boomerang seeded test invoice (sandbox)",
          payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: inv.dueDate },
        },
        invoicer: { email_address: merchantEmail },
        primary_recipients: [
          {
            billing_info: {
              name: { full_name: planned.customer.name },
              email_address: planned.customer.email,
              // PayPal blocks invoices to recipients inside India, so seeded customers are US-addressed.
              address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
            },
          },
        ],
        items: [{ name: inv.description, quantity: "1", unit_amount: { currency_code: planned.currency, value: (planned.amountCents / 100).toFixed(2) } }],
      },
    },
    { idempotencyKey: `${key}:create` },
  );
  const invoiceId = created.data.id ?? created.data.href?.split("/").pop();
  if (!invoiceId) throw new Error(`PayPal returned no invoice id for ${key}`);
  await gateway.callTool("seeder", "send_invoice", { invoice_id: invoiceId, send_to_recipient: true }, { idempotencyKey: `${key}:send` });
  return invoiceId;
}

function offlineInvoiceId(seed: string, index: number): string {
  const id = new Rng(seed).id(16, "offline-invoice", index);
  return `INV2-${id.slice(0, 4)}-${id.slice(4, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}`;
}

/**
 * Step 3.3: seeds a batch. Re-running with the same seed, size and mode resumes the same batch:
 * PayPal calls are idempotent per case, and case rows are not duplicated.
 */
export async function seedBatch(o: SeedOptions): Promise<SeedSummary> {
  const size = o.size ?? o.config.batch.size;
  if (o.mode === "sandbox" && (!o.gateway || !o.merchantEmail)) throw new Error("sandbox mode needs a PayPal gateway and merchant email");
  const plan = planBatch(o.config, o.seed, size, o.now);
  const { db } = o;

  await db
    .insert(batches)
    .values({ name: `${o.mode} batch ${o.seed}`, seed: o.seed, size, mode: o.mode, simConfig: o.config })
    .onConflictDoNothing();
  const [batch] = await db
    .select()
    .from(batches)
    .where(and(eq(batches.seed, o.seed), eq(batches.size, size), eq(batches.mode, o.mode)));
  const batchId = batch!.id;

  const profileValues = (caseId: string, p: PlannedCase) => ({
    caseId,
    batchId,
    batchIndex: p.profile.batchIndex,
    customerType: p.profile.customerType,
    failureKind: p.profile.failureKind,
    hidden: { reasonCode: p.subscription?.reasonCode ?? null, daysOverdue: p.invoice?.daysOverdue ?? null },
  });

  // Invoices: real sandbox invoices (or offline ids), then the case row. The overdue poller (4.4)
  // would open these itself; the seeder opens them directly so the batch is complete at once.
  const invoicePlans = plan.cases.filter((c) => c.profile.lane === "invoice");
  let done = 0;
  await pool(invoicePlans, o.concurrency ?? 4, async (p) => {
    const invoiceId = o.mode === "sandbox" ? await createSandboxInvoice(o.gateway!, o.merchantEmail!, p, o.seed) : offlineInvoiceId(o.seed, p.profile.batchIndex);
    await db.transaction(async (tx) => {
      const [customer] = await tx
        .insert(customers)
        .values({ paypalPayerRef: p.customer.payerRef, email: p.customer.email, name: p.customer.name, timezone: p.customer.timezone, simulated: true })
        .onConflictDoUpdate({ target: customers.paypalPayerRef, set: { timezone: p.customer.timezone } })
        .returning({ id: customers.id });
      await tx
        .insert(cases)
        .values({
          lane: "invoice",
          paypalRef: invoiceId,
          customerId: customer!.id,
          amountCents: p.amountCents,
          currency: p.currency,
          batchId,
          simulated: o.mode === "offline",
        })
        .onConflictDoNothing();
      const [row] = await tx.select({ id: cases.id }).from(cases).where(and(eq(cases.lane, "invoice"), eq(cases.paypalRef, invoiceId), isNull(cases.closedAt)));
      await tx.insert(simProfiles).values(profileValues(row!.id, p)).onConflictDoNothing();
    });
    if (++done % 25 === 0) o.logger?.info({ done, of: invoicePlans.length }, "invoices seeded");
  });

  // Subscriptions: signed failure events through the API, then the case opener turns them into cases.
  const subPlans = plan.cases.filter((c) => c.profile.lane === "subscription");
  await pool(subPlans, o.concurrency ?? 4, async (p) => {
    await injectSubscriptionFailure(o.poster, o.simSecret, p, o.seed, o.now);
  });
  await processPendingEvents(db, { limit: 10_000, logger: o.logger });
  const subRows = await db
    .select({ id: cases.id, paypalRef: cases.paypalRef })
    .from(cases)
    .where(and(eq(cases.lane, "subscription"), inArray(cases.paypalRef, subPlans.map((p) => p.subscription!.id)), isNull(cases.closedAt)));
  const byRef = new Map(subRows.map((r) => [r.paypalRef, r.id]));
  for (const p of subPlans) {
    const caseId = byRef.get(p.subscription!.id);
    if (!caseId) throw new Error(`no case opened for simulated subscription ${p.subscription!.id}`);
    await db.update(cases).set({ batchId }).where(eq(cases.id, caseId));
    await db.insert(simProfiles).values(profileValues(caseId, p)).onConflictDoNothing();
  }

  // Step 3.5: stratified assignment over the whole batch.
  const batchCases = await db
    .select({ id: cases.id, lane: cases.lane, amountCents: cases.amountCents })
    .from(cases)
    .where(eq(cases.batchId, batchId));
  const arms = assignArms(batchCases, o.seed);
  for (const arm of ["control", "treatment"] as const) {
    const ids = batchCases.filter((c) => arms.get(c.id) === arm).map((c) => c.id);
    if (ids.length) await db.update(cases).set({ experimentGroup: arm, updatedAt: sql`now()` }).where(inArray(cases.id, ids));
  }

  const count = (arm: string) => batchCases.filter((c) => arms.get(c.id) === arm).length;
  return {
    batchId,
    invoices: invoicePlans.length,
    subscriptions: subPlans.length,
    control: count("control"),
    treatment: count("treatment"),
    atRiskCents: batchCases.reduce((s, c) => s + c.amountCents, 0),
  };
}
