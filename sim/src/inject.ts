import { SIM_SIGNATURE_HEADER, signSimulatedEvent } from "@boomerang/core";
import type { PlannedCase } from "./generate";

/** Sends one signed simulated event; returns the HTTP status. Swappable so tests can use app.inject. */
export type EventPoster = (rawBody: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;

export function httpPoster(apiUrl: string): EventPoster {
  return async (rawBody, headers) => {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/webhooks/simulated`, { method: "POST", headers, body: rawBody });
    return { status: res.status, body: await res.text() };
  };
}

/**
 * Step 3.4: a BILLING.SUBSCRIPTION.PAYMENT.FAILED payload in PayPal's shape, for a subscription the
 * sandbox will not fail by itself. Marked simulated twice: the WH-SIM- id prefix and a flag.
 */
export function subscriptionFailurePayload(planned: PlannedCase, seed: string, at: Date = new Date()): Record<string, unknown> {
  const sub = planned.subscription;
  if (!sub) throw new Error("not a subscription case");
  const [given, ...rest] = planned.customer.name.split(" ");
  const amount = { currency_code: planned.currency, value: (planned.amountCents / 100).toFixed(2) };
  return {
    id: `WH-SIM-${seed}-${planned.profile.batchIndex}-F${sub.failedPayments}`,
    event_version: "1.0",
    create_time: at.toISOString(),
    resource_type: "subscription",
    event_type: "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
    summary: "Subscription payment failed (simulated by Boomerang)",
    boomerang_simulated: true,
    resource: {
      id: sub.id,
      status: "ACTIVE",
      plan_id: "P-SIMULATED",
      subscriber: {
        email_address: planned.customer.email,
        payer_id: planned.customer.payerRef,
        name: { given_name: given, surname: rest.join(" ") },
      },
      billing_info: {
        outstanding_balance: amount,
        failed_payments_count: sub.failedPayments,
        last_failed_payment: { amount, time: at.toISOString(), reason_code: sub.reasonCode },
      },
    },
  };
}

export async function injectSubscriptionFailure(
  poster: EventPoster,
  secret: string,
  planned: PlannedCase,
  seed: string,
  at?: Date,
): Promise<{ eventId: string; status: number }> {
  const payload = subscriptionFailurePayload(planned, seed, at);
  const rawBody = JSON.stringify(payload);
  const res = await poster(rawBody, { "content-type": "application/json", [SIM_SIGNATURE_HEADER]: signSimulatedEvent(secret, rawBody) });
  if (res.status !== 200) throw new Error(`simulated event rejected: HTTP ${res.status} ${res.body}`);
  return { eventId: payload.id as string, status: res.status };
}
