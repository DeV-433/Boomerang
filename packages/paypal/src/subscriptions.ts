import type { CallResult, PayPalGateway } from "./gateway";

export interface PayPalSubscription {
  id: string;
  status: "APPROVAL_PENDING" | "APPROVED" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED" | string;
  plan_id?: string;
  subscriber?: { email_address?: string; payer_id?: string };
  billing_info?: {
    outstanding_balance?: { currency_code: string; value: string };
    failed_payments_count?: number;
    last_failed_payment?: { amount?: { currency_code: string; value: string }; time?: string; reason_code?: string };
    next_billing_time?: string;
  };
  [key: string]: unknown;
}

/** 2.8: status, failed-payment count and outstanding balance for a subscription (read-only). */
export async function showSubscriptionDetails(gw: PayPalGateway, subscriptionId: string): Promise<PayPalSubscription> {
  const { data } = await gw.callTool<PayPalSubscription>("subscription", "show_subscription_details", {
    subscription_id: subscriptionId,
  });
  return data;
}

/** The summary the diagnosis step needs, pulled out of PayPal's nested shape. */
export function subscriptionRisk(sub: PayPalSubscription): {
  status: string;
  failedPayments: number;
  outstanding: { currencyCode: string; value: string } | null;
  lastFailureReason: string | null;
} {
  const balance = sub.billing_info?.outstanding_balance;
  return {
    status: sub.status,
    failedPayments: sub.billing_info?.failed_payments_count ?? 0,
    outstanding: balance && Number(balance.value) > 0 ? { currencyCode: balance.currency_code, value: balance.value } : null,
    lastFailureReason: sub.billing_info?.last_failed_payment?.reason_code ?? null,
  };
}

/**
 * 2.9: captures a subscription's outstanding balance. The toolkit has no tool for this, so it is a
 * direct call to POST /v1/billing/subscriptions/{id}/capture. It moves money, so the policy gate
 * always holds it for human approval (rule 12) before this is ever called.
 */
export async function captureSubscriptionBalance(
  gw: PayPalGateway,
  input: { subscriptionId: string; amount: { currencyCode: string; value: string }; note: string },
  idempotencyKey: string,
): Promise<CallResult<{ id?: string; status?: string }>> {
  if (!/^I-[A-Z0-9]+$/.test(input.subscriptionId)) throw new Error(`Invalid subscription id: ${input.subscriptionId}`);
  return gw.callRest(
    "subscription",
    "capture_subscription_balance",
    {
      method: "POST",
      path: `/v1/billing/subscriptions/${input.subscriptionId}/capture`,
      body: {
        note: input.note.slice(0, 128),
        capture_type: "OUTSTANDING_BALANCE",
        amount: { currency_code: input.amount.currencyCode, value: input.amount.value },
      },
    },
    { idempotencyKey },
  );
}
