/**
 * Live sandbox verification for BUILD_PLAN steps 2.8 and 2.9 (subscription lane).
 *   npx tsx scripts/sandbox-subscription.ts setup            create product, plan, subscription; prints approve link
 *   npx tsx scripts/sandbox-subscription.ts check <I-...>    2.8: status and failed-payment count
 *   npx tsx scripts/sandbox-subscription.ts capture <I-...>  2.9: give it a balance, then capture it
 */
import { createLogger, loadConfig, requireConfig } from "@boomerang/core";
import { createDb } from "@boomerang/db";
import { captureSubscriptionBalance, createPayPal, showSubscriptionDetails, subscriptionRisk } from "../src/index";

const config = loadConfig();
if (config.PAYPAL_ENVIRONMENT !== "SANDBOX") throw new Error("sandbox only");
const db = createDb(requireConfig(config, "DATABASE_URL"));
const { gateway } = createPayPal(config, { db: db.db, logger: createLogger({ name: "sandbox-sub", level: "warn" }) });
const [command, subscriptionId] = process.argv.slice(2);
const run = `sub-${Date.now()}`;

try {
  if (command === "setup") {
    const product = await gateway.callTool<{ id: string }>(
      "seeder",
      "create_product",
      { name: "Boomerang Test Service", type: "SERVICE", description: "Phase 2 subscription check" },
      { idempotencyKey: `${run}:product` },
    );
    const plan = await gateway.callTool<{ id: string }>(
      "seeder",
      "create_subscription_plan",
      {
        product_id: product.data.id,
        name: "Boomerang Daily Test Plan",
        billing_cycles: [
          {
            frequency: { interval_unit: "DAY", interval_count: 1 },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: { fixed_price: { currency_code: "USD", value: "9.99" } },
          },
        ],
        // auto_bill_outstanding off: a failed amount stays as an outstanding balance for Boomerang to recover.
        payment_preferences: { auto_bill_outstanding: false, payment_failure_threshold: 3 },
      },
      { idempotencyKey: `${run}:plan` },
    );
    const sub = await gateway.callTool<{ id: string; status: string; links?: { href: string; rel: string }[] }>(
      "seeder",
      "create_subscription",
      {
        plan_id: plan.data.id,
        application_context: {
          brand_name: "Boomerang",
          user_action: "SUBSCRIBE_NOW",
          return_url: "https://boomerang-api-rgd8.onrender.com/healthz",
          cancel_url: "https://boomerang-api-rgd8.onrender.com/healthz",
        },
      },
      { idempotencyKey: `${run}:subscription` },
    );
    console.log(`product=${product.data.id} plan=${plan.data.id}`);
    console.log(`SUBSCRIPTION_ID=${sub.data.id} status=${sub.data.status}`);
    console.log(`APPROVE_URL=${sub.data.links?.find((l) => l.rel === "approve")?.href}`);
  } else if (command === "check" && subscriptionId) {
    const sub = await showSubscriptionDetails(gateway, subscriptionId);
    console.log("2.8", JSON.stringify(subscriptionRisk(sub)), `next_billing=${sub.billing_info?.next_billing_time ?? "-"}`);
  } else if (command === "capture" && subscriptionId) {
    await gateway.callRest(
      "seeder",
      "set_subscription_outstanding_balance",
      {
        method: "PATCH",
        path: `/v1/billing/subscriptions/${subscriptionId}`,
        body: [{ op: "replace", path: "/billing_info/outstanding_balance", value: { currency_code: "USD", value: "9.99" } }],
      },
      { idempotencyKey: `${run}:set-balance` },
    );
    const before = subscriptionRisk(await showSubscriptionDetails(gateway, subscriptionId));
    console.log("before capture", JSON.stringify(before));
    const capture = await captureSubscriptionBalance(
      gateway,
      { subscriptionId, amount: { currencyCode: "USD", value: before.outstanding?.value ?? "9.99" }, note: "Boomerang balance capture check" },
      `${run}:capture`,
    );
    console.log("capture response", JSON.stringify(capture.data));
    const after = subscriptionRisk(await showSubscriptionDetails(gateway, subscriptionId));
    console.log("after capture ", JSON.stringify(after));
  } else {
    console.log("usage: setup | check <subscription-id> | capture <subscription-id>");
  }
} finally {
  await db.close();
}
