# External facts re-checked (BUILD_PLAN 9.9)

Checked on 2026-11-11 against the providers' current pages. Every name below is one the code depends on.
Re-run this list before a demo or after upgrading a dependency.

## PayPal webhook events

Source: [Webhook event names](https://developer.paypal.com/api/rest/webhooks/event-names/).

- [x] `BILLING.SUBSCRIPTION.PAYMENT.FAILED` (Subscriptions)
- [x] `BILLING.SUBSCRIPTION.SUSPENDED` (Subscriptions; also listed under the deprecated Billing Agreements section, but current under Subscriptions)
- [x] `BILLING.SUBSCRIPTION.CANCELLED` (same as above)
- [x] `PAYMENT.SALE.COMPLETED` (Sales and Subscriptions)
- [x] `INVOICING.INVOICE.PAID`, `.CANCELLED`, `.REFUNDED`, `.UPDATED` (Invoicing; the page links the v1 methods, the event names are unchanged)
- [x] `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED` (Disputes)
- [x] `BOOMERANG.*` events are Boomerang's own (poller, pay page, simulator) and never come from PayPal.

## PayPal webhook delivery

Source: [Webhooks overview](https://developer.paypal.com/api/rest/webhooks/rest/).

- [x] Headers: `paypal-transmission-id`, `paypal-transmission-time`, `paypal-cert-url`, `paypal-transmission-sig` (plus `paypal-auth-algo`, sent with every delivery and required by the verification API).
- [x] Signature covers `transmission_id | transmission_time | webhook_id | crc32(raw body)`, so the raw body must be kept (it is).
- [x] Retries: up to 25 times over 3 days on a non-2xx answer. Boomerang answers 503 when it cannot verify, so PayPal retries.
- [ ] **Not documented:** whether a retry carries a new transmission time. The replay window (9.6) is therefore 4 days, longer than the retry span, so it cannot reject a genuine retry. To settle it, fail one sandbox delivery on purpose and compare the retry's headers.

## PayPal REST endpoints called directly

- [x] `POST /v1/oauth2/token` (client credentials).
- [x] `POST /v1/notifications/verify-webhook-signature` ([Webhooks API](https://developer.paypal.com/docs/api/webhooks/v1/)).
- [x] `POST /v1/billing/subscriptions/{id}/capture`, "captures an authorized payment from the subscriber on the subscription" ([Subscriptions API](https://developer.paypal.com/docs/api/subscriptions/v1/)). Verified end to end in the sandbox on 2026-11-10 (8.6).
- [x] Base URLs `https://api-m.sandbox.paypal.com` and `https://api-m.paypal.com`.

## PayPal Agent Toolkit

- [x] `@paypal/agent-toolkit` 1.11.0 is pinned and is still the latest release on npm (published 2026-09-01).
- [x] Every whitelisted tool exists in the installed 1.11.0: `list_invoices`, `get_invoice`, `send_invoice_reminder`,
      `cancel_invoice_auto_reminder`, `record_payment_for_invoice`, `generate_invoice_qr_code`, `get_order`,
      `list_disputes`, `get_dispute`, `list_transactions`, `show_subscription_details`, `list_subscription_plans`,
      `create_invoice`, `send_invoice`, `create_product`, `create_subscription_plan`, `create_subscription`.
      (`capture_subscription_balance` and `create_invoice_with_terms` are Boomerang's own REST calls; the toolkit has no tool for them.)
- [x] The three toolkit 1.11.0 problems worked around in `packages/paypal` (no token refresh, `run()` hides errors,
      `create_invoice` has no due date) still apply: no newer release.

## Render

Source: [Blueprint spec](https://render.com/docs/blueprint-spec).

- [x] `boomerang-db` plan `0.1c-256mb` is a valid Postgres plan (Postgres only).
- [x] `boomerang-api` and `boomerang-worker` plan `0.5c-512mb` is valid for web services and background workers (workers have no free plan).
- [x] `preDeployCommand` (migrations) is available on paid web services and workers, which both are.
- [x] `autoDeployTrigger: commit` is valid (`commit`, `checksPass`, `off`). With no CI on the account, `commit` plus the local pre-push hook is the gate.
- [x] Region `singapore` is valid for services and Postgres.

## Groq

Source: [Rate limits](https://console.groq.com/docs/rate-limits).

- [x] `openai/gpt-oss-120b` and `openai/gpt-oss-20b`: 30 requests/min, 1K requests/day, 8K tokens/min, 200K tokens/day each.
      The page calls these the base limits; they match the headers the key returned while building.
- [x] Limits apply per organization, which is why teammates' keys (`GROQ_API_KEYS`, local only) add capacity.
- [x] `GROQ_RPM=25` stays under the 30 requests/min limit.

## Still to check by hand (needs the PayPal sandbox dashboard)

- [ ] The sandbox webhook (`PAYPAL_WEBHOOK_ID`) still points at `https://boomerang-api-rgd8.onrender.com/webhooks/paypal` and subscribes to every PayPal event above.
- [ ] Retry header behaviour, as noted above.
