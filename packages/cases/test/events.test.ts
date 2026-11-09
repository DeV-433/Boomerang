import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { cases, customers, events, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import { processPendingEvents } from "../src/events";

describe.skipIf(!hasTestDb)("event processing: subscription payment failed", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await setupTestDb();
  });
  afterAll(async () => {
    await h?.close();
  });

  async function storeFailure(subscriptionId: string, payerId: string, value: string, simulated = true) {
    const id = `WH-SIM-${randomUUID()}`;
    const payload = {
      id,
      event_type: "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
      resource: {
        id: subscriptionId,
        subscriber: {
          payer_id: payerId,
          email_address: `${payerId}@example.com`,
          name: { given_name: "Ada", surname: "Lovelace" },
        },
        billing_info: {
          outstanding_balance: { currency_code: "USD", value },
          last_failed_payment: { amount: { currency_code: "USD", value }, reason_code: "PAYER_CANNOT_PAY" },
        },
      },
    };
    await h.db.insert(events).values({
      paypalEventId: id,
      type: payload.event_type,
      resourceId: subscriptionId,
      payload,
      rawBody: JSON.stringify(payload),
      headers: {},
      source: "simulated",
      simulated,
    });
    return id;
  }

  const openCases = (ref: string) =>
    h.db
      .select()
      .from(cases)
      .where(and(eq(cases.paypalRef, ref), isNull(cases.closedAt)));

  it("opens a subscription case with the customer and amount at risk, and links the event", async () => {
    const sub = `I-T${randomUUID().slice(0, 8).toUpperCase()}`;
    const payer = `P${randomUUID().slice(0, 10)}`;
    const eventId = await storeFailure(sub, payer, "49.00");
    await processPendingEvents(h.db);

    const [kase] = await openCases(sub);
    expect(kase).toMatchObject({
      lane: "subscription",
      amountCents: 4900,
      currency: "USD",
      state: "detected",
      simulated: true,
    });
    const [customer] = await h.db.select().from(customers).where(eq(customers.id, kase!.customerId));
    expect(customer).toMatchObject({ paypalPayerRef: payer, name: "Ada Lovelace" });
    const [event] = await h.db.select().from(events).where(eq(events.paypalEventId, eventId));
    expect(event!.caseId).toBe(kase!.id);
    expect(event!.processedAt).not.toBeNull();
  });

  it("a second failure for the same subscription updates the open case instead of opening another", async () => {
    const sub = `I-T${randomUUID().slice(0, 8).toUpperCase()}`;
    const payer = `P${randomUUID().slice(0, 10)}`;
    await storeFailure(sub, payer, "19.00");
    await storeFailure(sub, payer, "38.00");
    await processPendingEvents(h.db);
    const open = await openCases(sub);
    expect(open).toHaveLength(1);
    expect(open[0]!.amountCents).toBe(3800);
  });

  it("is safe to run from two processes at once", async () => {
    const sub = `I-T${randomUUID().slice(0, 8).toUpperCase()}`;
    const payer = `P${randomUUID().slice(0, 10)}`;
    await Promise.all([
      storeFailure(sub, payer, "10.00"),
      storeFailure(sub, payer, "10.00"),
      storeFailure(sub, payer, "10.00"),
    ]);
    await Promise.all([processPendingEvents(h.db), processPendingEvents(h.db)]);
    expect(await openCases(sub)).toHaveLength(1);
  });

  it("marks event types with no handler as processed, linked to no case", async () => {
    const id = `WH-${randomUUID()}`;
    await h.db
      .insert(events)
      .values({
        paypalEventId: id,
        type: "INVOICING.INVOICE.CREATED",
        payload: {},
        rawBody: "{}",
        headers: {},
      });
    await processPendingEvents(h.db);
    const [row] = await h.db.select().from(events).where(eq(events.paypalEventId, id));
    expect(row!.processedAt).not.toBeNull();
    expect(row!.caseId).toBeNull();
  });
});
