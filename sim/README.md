# Simulator

Stand-in customers for measuring Boomerang against a fixed-schedule baseline. Every number it uses lives in
[`config/simulator.json`](config/simulator.json), is validated on load, and is stored with every batch and run so
results can be reproduced and shown next to the numbers they produced.

> **Read this before quoting a result.** The simulator encodes our assumptions about how customers behave. Any
> uplift it reports reflects those assumptions, not real customers. Results are only meaningful alongside the
> config that produced them, and across a range of configs (BUILD_PLAN 9.2), never as a single number.

## Commands

```bash
npm run sim:seed -- --seed demo-1 --size 300 --mode sandbox --api http://localhost:3000
npm run sim:baseline -- --batch latest --arm control
```

- `--mode sandbox` creates real, backdated, sent PayPal sandbox invoices (idempotent per seed and case, so a rerun
  resumes). `--mode offline` uses simulated invoice ids and makes no PayPal calls.
- Subscription failures are always injected as signed `BILLING.SUBSCRIPTION.PAYMENT.FAILED` events through the
  API's sandbox-only `/webhooks/simulated` route, so the API must be running with `SIM_WEBHOOK_SECRET` set.

## Customer types

Each case gets one hidden type, stored in `sim_profiles`. Decision code must never read that table.

| Type | Behaviour |
| --- | --- |
| `would_pay_after_nudge` | Pays readily once reminded; best response to a targeted reminder |
| `needs_card_update` | Subscription with a hard failure; PayPal retries never succeed until the card is updated, so only an update-payment message works well |
| `promises_then_pays` | Needs time; a payment-plan offer usually gets a promise, and a promise check gets the money |
| `slow_payer` | Low response to any one contact; most likely to pay on their own eventually |
| `disputer` | Contact provokes a dispute, firm wording more so; disputes end any recovery |
| `opts_out` | High chance of opting out on contact; rises with every message |

## Config reference

| Key | Meaning |
| --- | --- |
| `horizonDays` | How many simulated days each case runs |
| `batch.size` | Default number of cases |
| `batch.laneMix` | Share of invoice and subscription cases (sums to 1) |
| `batch.typeMix.<lane>` | Share of each customer type within a lane (sums to 1) |
| `batch.invoiceAmount` | Log-normal invoice amounts: median, spread, clamped to min and max dollars |
| `batch.subscriptionPrices`, `subscriptionPriceWeights` | Plan prices and how often each occurs |
| `batch.invoiceDaysOverdue` | How overdue invoices already are when seeded |
| `batch.softFailureShare.<type>` | For subscriptions: chance the failure is soft (may clear on a PayPal retry) rather than hard |
| `batch.timezones` | Customer time zones; `null` means unknown (the gate falls back to narrower hours) |
| `responses.<type>.<contact>` | Chance that one contact of that kind gets `pay`, `promise`, `dispute` or `optOut`; the rest is `ignore`. `default` applies to any contact kind without its own row |
| `fatigue.perPriorContact` | Pay and promise chances are multiplied by this for every earlier message |
| `fatigue.optOutIncreasePerPriorContact` | Added to the opt-out chance for every earlier message |
| `payDelayDays` | Days between agreeing to pay and the money arriving |
| `promise.inDays` | How far ahead customers promise to pay |
| `promise.keepProbability.<type>` | Chance a promise is kept |
| `dailySelfPay.<type>` | Chance per day of paying with no contact at all |
| `paypalRetry` | PayPal's own behaviour, identical in both arms: retry every `intervalDays`, at most `maxRetriesPerCycle` times, suspend at `paymentFailureThreshold` failures; soft failures clear with `softSuccessProbability`, and after a card update with `afterCardUpdateSuccessProbability` |
| `baseline.invoiceReminderDays` | Days the fixed schedule reminds an invoice customer (PayPal auto-reminders) |
| `baseline.subscriptionDunningDays` | Days the fixed schedule emails a subscription customer |

Contact kinds: `generic_reminder`, `targeted_reminder`, `firm_reminder`, `payment_plan_offer`, `promise_check`,
`update_payment_message`, and `paypal_failure_notice` (PayPal's own failure email, sent in both arms).

## How a run works

Each case is simulated day by day on a virtual clock. Every random draw is keyed by the case's batch index, the
purpose and the day, not by draw order, so:

- the same seed reproduces the same batch and the same run exactly;
- one case's events never shift another case's numbers;
- a policy change in a what-if replay (7A) only changes the draws it actually touches.

Each day: money already promised or on its way arrives; PayPal retries subscriptions on its schedule; the customer
may pay unprompted; then the strategy's contacts for that day are answered by the responder.

The baseline strategy sends `generic_reminder` on the configured days and stops only on payment. It does not read
replies, so it keeps contacting customers after they opt out or dispute. The engine counts those contacts
(`contactsAfterOptOut`), and for Boomerang that number must be zero.

## Known limits

- PayPal retry success rates and every response probability are assumptions, not measured PayPal figures.
- Partial payments are not modelled; a case recovers its full amount or nothing.
- Subscription cases are simulated objects (`I-SIM…`), because the sandbox cannot fail payments on demand.
  Invoice cases in sandbox mode are real PayPal invoices.
