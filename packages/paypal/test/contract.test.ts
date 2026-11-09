import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runToolkitMethod, PINNED_TOOLKIT_VERSION, toolkitVersion, toolRegistry } from "../src/toolkit";
import { REST_OPERATIONS, TOOL_WHITELIST } from "../src/whitelist";
import { fakePayPal, INVOICE_ID, SUBSCRIPTION_ID } from "./fake-paypal";

/**
 * Step 2.10: the contract between Boomerang and the pinned toolkit. One entry per whitelisted tool:
 * the flag that enables it, the parameters Boomerang relies on, sample arguments in the exact shape
 * our wrappers send, and the HTTP request the toolkit must make for them.
 */
const CONTRACT: Record<
  string,
  { actions: Record<string, Record<string, boolean>>; params: string[]; sample: Record<string, unknown>; request: string }
> = {
  list_invoices: {
    actions: { invoices: { list: true } },
    params: ["page", "page_size", "total_required"],
    sample: { page: 1, page_size: 100, total_required: true },
    request: "GET /v2/invoicing/invoices",
  },
  get_invoice: {
    actions: { invoices: { get: true } },
    params: ["invoice_id"],
    sample: { invoice_id: INVOICE_ID },
    request: `GET /v2/invoicing/invoices/${INVOICE_ID}`,
  },
  send_invoice_reminder: {
    actions: { invoices: { sendReminder: true } },
    params: ["invoice_id", "subject", "note"],
    sample: { invoice_id: INVOICE_ID, note: "Reminder" },
    request: `POST /v2/invoicing/invoices/${INVOICE_ID}/remind`,
  },
  cancel_invoice_auto_reminder: {
    actions: { invoices: { cancelReminders: true } },
    params: ["invoice_id"],
    sample: { invoice_id: INVOICE_ID },
    request: `POST /v2/invoicing/invoices/${INVOICE_ID}/cancel-reminders`,
  },
  record_payment_for_invoice: {
    actions: { invoices: { recordPayment: true } },
    params: ["invoice_id", "method", "payment_date", "amount", "note"],
    sample: {
      invoice_id: INVOICE_ID,
      method: "PAYPAL",
      payment_date: "2026-11-09",
      amount: { currency_code: "USD", value: "12.50" },
    },
    request: `POST /v2/invoicing/invoices/${INVOICE_ID}/payments`,
  },
  generate_invoice_qr_code: {
    actions: { invoices: { generateQRC: true } },
    params: ["invoice_id", "width", "height"],
    sample: { invoice_id: INVOICE_ID },
    request: `POST /v2/invoicing/invoices/${INVOICE_ID}/generate-qr-code`,
  },
  show_subscription_details: {
    actions: { subscriptions: { show: true } },
    params: ["subscription_id"],
    sample: { subscription_id: SUBSCRIPTION_ID },
    request: `GET /v1/billing/subscriptions/${SUBSCRIPTION_ID}`,
  },
};

/** Tools we only check exist with their flag (reads with no Phase 2 wrapper yet, and the seeder's). */
const EXISTS_ONLY = [
  ...new Set([...TOOL_WHITELIST.invoice, ...TOOL_WHITELIST.subscription, ...TOOL_WHITELIST.seeder]),
].filter((t) => !(t in CONTRACT) && !(REST_OPERATIONS as readonly string[]).includes(t));

describe("toolkit contract (2.10)", () => {
  it("runs against the exact pinned toolkit version", () => {
    expect(toolkitVersion()).toBe(PINNED_TOOLKIT_VERSION);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@paypal/agent-toolkit"]).toBe(PINNED_TOOLKIT_VERSION); // exact, no ^ or ~
  });

  it("covers every whitelisted toolkit tool", () => {
    const whitelisted = new Set([...TOOL_WHITELIST.invoice, ...TOOL_WHITELIST.subscription].filter((t) => !REST_OPERATIONS.includes(t as never)));
    for (const tool of whitelisted) expect(Object.keys(CONTRACT).concat(EXISTS_ONLY), tool).toContain(tool);
  });

  describe.each(Object.entries(CONTRACT))("%s", (tool, spec) => {
    const definition = () => toolRegistry().get(tool);

    it("exists under this exact name with the expected enabling flag", () => {
      expect(definition(), `toolkit has no tool named ${tool}`).toBeDefined();
      expect(definition()!.actions).toEqual(spec.actions);
    });

    it("still accepts the parameters Boomerang sends", () => {
      const shape = Object.keys(definition()!.parameters.shape ?? {});
      for (const param of spec.params) expect(shape, `${tool} lost parameter ${param}`).toContain(param);
      const parsed = definition()!.parameters.safeParse(spec.sample);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });
  });

  it.each(EXISTS_ONLY)("%s still exists in the toolkit", (tool) => {
    expect(toolRegistry().get(tool), `toolkit has no tool named ${tool}`).toBeDefined();
  });

  describe("HTTP behaviour", () => {
    const paypal = fakePayPal();
    beforeAll(() => paypal.server.listen({ onUnhandledFrame: "error" }));
    afterAll(() => paypal.server.close());
    beforeEach(() => paypal.reset());

    it.each(Object.entries(CONTRACT))("%s calls the expected PayPal endpoint", async (tool, spec) => {
      const parsed = toolRegistry().get(tool)!.parameters.safeParse(spec.sample);
      await runToolkitMethod(tool, parsed.data, { accessToken: "contract", sandbox: true, requestId: "contract-key" });
      const calls = paypal.requests.map((r) => `${r.method} ${r.path}`);
      expect(calls).toEqual([spec.request]);
      expect(paypal.requests[0]!.headers["paypal-request-id"]).toBe("contract-key");
      expect(paypal.unexpected).toEqual([]);
    });
  });
});
