import { HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InvalidToolArgumentsError } from "../src/gateway";
import { IdempotencyInFlightError, MemoryIdempotencyStore } from "../src/idempotency";
import {
  cancelInvoiceAutoReminder,
  getInvoice,
  listAllInvoices,
  listInvoices,
  recordPaymentForInvoice,
  sendInvoiceReminder,
} from "../src/invoices";
import { captureSubscriptionBalance, showSubscriptionDetails, subscriptionRisk } from "../src/subscriptions";
import { ToolNotAllowedError } from "../src/whitelist";
import { fakePayPal, INVOICE_ID, makeGateway, SUBSCRIPTION_ID } from "./fake-paypal";

const paypal = fakePayPal();
beforeAll(() => paypal.server.listen({ onUnhandledFrame: "error" }));
afterAll(() => paypal.server.close());
beforeEach(() => paypal.reset());
afterEach(() => expect(paypal.unexpected).toEqual([]));

describe("invoice wrappers through the real toolkit (2.4 to 2.7)", () => {
  it("lists and gets invoices", async () => {
    const { gateway } = makeGateway();
    const list = await listInvoices(gateway);
    expect(list.items?.[0]?.id).toBe(INVOICE_ID);
    expect(paypal.callsTo("GET", "/v2/invoicing/invoices")[0]?.headers.authorization).toBe("Bearer token-1");

    const invoice = await getInvoice(gateway, INVOICE_ID);
    expect(invoice).toMatchObject({ id: INVOICE_ID, status: "SENT" });
  });

  it("follows pages until the last one", async () => {
    const { gateway } = makeGateway();
    const page = (n: number) => ({ items: Array.from({ length: 2 }, (_, i) => ({ id: `INV2-${n}-${i}` })), total_pages: 2 });
    paypal.script("GET /v2/invoicing/invoices", HttpResponse.json(page(1)), HttpResponse.json(page(2)));
    expect((await listAllInvoices(gateway, 2)).map((i) => i.id)).toEqual(["INV2-1-0", "INV2-1-1", "INV2-2-0", "INV2-2-1"]);
  });

  it("rejects arguments that fail the toolkit's own schema before calling PayPal", async () => {
    const { gateway } = makeGateway();
    await expect(gateway.callTool("invoice", "get_invoice", { invoice_id: 42 })).rejects.toThrow(InvalidToolArgumentsError);
    await expect(
      gateway.callTool("invoice", "record_payment_for_invoice", { invoice_id: INVOICE_ID, method: "BITCOIN" }),
    ).rejects.toThrow(InvalidToolArgumentsError);
    expect(paypal.requests.filter((r) => !r.path.endsWith("/token"))).toHaveLength(0);
  });

  it("sends a reminder with the idempotency key as PayPal-Request-Id", async () => {
    const { gateway } = makeGateway();
    const result = await sendInvoiceReminder(gateway, { invoiceId: INVOICE_ID, note: "Friendly nudge" }, "case-1:send_reminder:1");
    expect(result.replayed).toBe(false);
    const [call] = paypal.callsTo("POST", "/remind");
    expect(call?.path).toBe(`/v2/invoicing/invoices/${INVOICE_ID}/remind`);
    expect(call?.headers["paypal-request-id"]).toBe("case-1:send_reminder:1");
    expect(call?.body).toMatchObject({ note: "Friendly nudge" });
  });

  // 2.5 Done when: calling twice with the same key sends once.
  it("sends once when called twice with the same key", async () => {
    const { gateway } = makeGateway();
    const first = await sendInvoiceReminder(gateway, { invoiceId: INVOICE_ID }, "case-2:send_reminder:1");
    const second = await sendInvoiceReminder(gateway, { invoiceId: INVOICE_ID }, "case-2:send_reminder:1");
    expect([first.replayed, second.replayed]).toEqual([false, true]);
    expect(paypal.callsTo("POST", "/remind")).toHaveLength(1);

    await sendInvoiceReminder(gateway, { invoiceId: INVOICE_ID }, "case-2:send_reminder:2");
    expect(paypal.callsTo("POST", "/remind")).toHaveLength(2);
  });

  it("refuses a concurrent duplicate while the first call is in flight", async () => {
    const store = new MemoryIdempotencyStore();
    await store.claim({ key: "busy", tool: "send_invoice_reminder", profile: "invoice", request: {} });
    const { gateway } = makeGateway({ idempotency: store });
    await expect(sendInvoiceReminder(gateway, { invoiceId: INVOICE_ID }, "busy")).rejects.toThrow(IdempotencyInFlightError);
    expect(paypal.callsTo("POST", "/remind")).toHaveLength(0);
  });

  it("lets a failed call be retried later with the same key", async () => {
    const { gateway } = makeGateway();
    paypal.script(`POST /v2/invoicing/invoices/${INVOICE_ID}/remind`, HttpResponse.json({ name: "UNPROCESSABLE_ENTITY" }, { status: 422 }));
    await expect(sendInvoiceReminder(gateway, { invoiceId: INVOICE_ID }, "case-3")).rejects.toMatchObject({ status: 422 });
    const retry = await sendInvoiceReminder(gateway, { invoiceId: INVOICE_ID }, "case-3");
    expect(retry.replayed).toBe(false);
    expect(paypal.callsTo("POST", "/remind")).toHaveLength(2);
  });

  it("cancels PayPal's automatic reminders for an invoice", async () => {
    const { gateway } = makeGateway();
    await cancelInvoiceAutoReminder(gateway, INVOICE_ID, "case-4:cancel_auto_reminder");
    expect(paypal.callsTo("POST", "/cancel-reminders")[0]?.path).toBe(`/v2/invoicing/invoices/${INVOICE_ID}/cancel-reminders`);
  });

  it("records a payment with amount, method and date", async () => {
    const { gateway } = makeGateway();
    const result = await recordPaymentForInvoice(
      gateway,
      { invoiceId: INVOICE_ID, amount: { currencyCode: "USD", value: "12.50" }, method: "PAYPAL", paymentDate: "2026-11-09" },
      "case-5:sim_pay",
    );
    expect(result.data).toMatchObject({ payment_id: "EXTR-1" });
    expect(paypal.callsTo("POST", "/payments")[0]?.body).toMatchObject({
      method: "PAYPAL",
      payment_date: "2026-11-09",
      amount: { currency_code: "USD", value: "12.50" },
    });
  });
});

describe("subscription wrappers (2.8, 2.9)", () => {
  it("shows status, failed-payment count and outstanding balance", async () => {
    const { gateway } = makeGateway();
    const sub = await showSubscriptionDetails(gateway, SUBSCRIPTION_ID);
    expect(subscriptionRisk(sub)).toEqual({
      status: "ACTIVE",
      failedPayments: 2,
      outstanding: { currencyCode: "USD", value: "15.00" },
      lastFailureReason: null,
    });
  });

  it("captures an outstanding balance by direct REST call, idempotently", async () => {
    const { gateway } = makeGateway();
    const input = { subscriptionId: SUBSCRIPTION_ID, amount: { currencyCode: "USD", value: "15.00" }, note: "Balance" };
    await captureSubscriptionBalance(gateway, input, "case-6:capture");
    await captureSubscriptionBalance(gateway, input, "case-6:capture");
    const calls = paypal.callsTo("POST", "/capture");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: `/v1/billing/subscriptions/${SUBSCRIPTION_ID}/capture`,
      body: { capture_type: "OUTSTANDING_BALANCE", amount: { currency_code: "USD", value: "15.00" } },
    });
    expect(calls[0]?.headers["paypal-request-id"]).toBe("case-6:capture");
  });

  it("refuses balance capture from the invoice lane", async () => {
    const { gateway } = makeGateway();
    await expect(gateway.callRest("invoice", "capture_subscription_balance", { method: "POST", path: "/x" })).rejects.toThrow(
      ToolNotAllowedError,
    );
  });
});

describe("error handling (2.11)", () => {
  // Done when: a simulated 429 retries then succeeds.
  it("backs off on 429, honouring Retry-After, then succeeds", async () => {
    const { gateway, sleeps } = makeGateway();
    paypal.script(
      "GET /v2/invoicing/invoices",
      HttpResponse.json({ name: "RATE_LIMIT_REACHED" }, { status: 429, headers: { "retry-after": "2" } }),
      HttpResponse.json({ name: "RATE_LIMIT_REACHED" }, { status: 429 }),
    );
    const list = await listInvoices(gateway);
    expect(list.items?.[0]?.id).toBe(INVOICE_ID);
    expect(paypal.callsTo("GET", "/v2/invoicing/invoices")).toHaveLength(3);
    expect(sleeps).toEqual([2000, 500]); // Retry-After 2 s, then jittered backoff for attempt 2 (0.5 x 1000 ms)
  });

  it("retries 5xx and keeps the full error body and debug id when it finally fails", async () => {
    const { gateway } = makeGateway();
    const longBody = { name: "INTERNAL_SERVER_ERROR", message: "x".repeat(500), debug_id: "abc" };
    const failure = () => HttpResponse.json(longBody, { status: 503, headers: { "paypal-debug-id": "dbg-503" } });
    paypal.script(`GET /v2/invoicing/invoices/${INVOICE_ID}`, failure(), failure(), failure(), failure());
    const error = await getInvoice(gateway, INVOICE_ID).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, debugId: "dbg-503", errorName: "INTERNAL_SERVER_ERROR" });
    expect((error as { body: string }).body).toBe(JSON.stringify(longBody)); // not cut to 200 characters
    expect(paypal.callsTo("GET", `/invoices/${INVOICE_ID}`)).toHaveLength(4);
  });

  it("does not retry client errors", async () => {
    const { gateway } = makeGateway();
    paypal.script(`GET /v2/invoicing/invoices/${INVOICE_ID}`, HttpResponse.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 }));
    await expect(getInvoice(gateway, INVOICE_ID)).rejects.toMatchObject({ status: 404 });
    expect(paypal.callsTo("GET", `/invoices/${INVOICE_ID}`)).toHaveLength(1);
  });

  it("refreshes the token and retries once when PayPal rejects it with 401", async () => {
    const { gateway } = makeGateway();
    paypal.script(`GET /v2/invoicing/invoices/${INVOICE_ID}`, HttpResponse.json({ name: "AUTHENTICATION_FAILURE" }, { status: 401 }));
    await expect(getInvoice(gateway, INVOICE_ID)).resolves.toMatchObject({ id: INVOICE_ID });
    const auths = paypal.callsTo("GET", `/invoices/${INVOICE_ID}`).map((r) => r.headers.authorization);
    expect(auths).toEqual(["Bearer token-1", "Bearer token-2"]);
  });
});
