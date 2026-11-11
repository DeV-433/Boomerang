# Boomerang

An agent that finds PayPal revenue at risk (overdue invoices, failed subscription payments), chooses a recovery
action for each case, carries it out inside rules a model cannot bend, and measures the money it won back against a
control group.

Built and demonstrated against the **PayPal sandbox** only. Live: dashboard https://boomerang-dashboard-abv8.onrender.com
(operator token required), API https://boomerang-api-rgd8.onrender.com/healthz.

A 73-second walkthrough of the demo: [`docs/demo/boomerang-demo.mp4`](docs/demo/boomerang-demo.mp4).

## What it does

1. **Detect.** PayPal webhooks (signature-verified, stored exactly once) and an invoice poller open a recovery case for
   every overdue invoice and failed subscription payment.
2. **Diagnose.** Each case gets a cause from a fixed table (overdue and unresponsive, card needs updating, soft failure
   PayPal will retry, promised to pay, disputed, opted out...).
3. **Propose.** An LLM agent (Groq `openai/gpt-oss-120b`, falling back to `gpt-oss-20b`, then to plain rules) picks one
   action from that lane's menu, as JSON validated against a schema. It sees structured case facts only: no names,
   emails, PayPal ids or customer text.
4. **Gate.** A deterministic 13-rule policy gate allows, blocks or holds every proposal: already resolved, dispute open,
   opted out, global pause, action whitelist, no contact before a date the customer promised, contact caps, 48-hour
   spacing, contact hours in the customer's time zone, approval above $2,000, confidence floor, message lint (body and
   subject), and a person's approval for anything that moves money. An approved action that cannot go out yet (outside
   contact hours) keeps its approval and goes out at the next check.
5. **Execute.** Allowed actions go to PayPal through one gateway, with idempotency keys and a fresh re-check of the
   invoice first. Dry-run mode records what would be sent, and counts it as a contact so the stages, spacing and caps
   run as they would live. Approved actions sent from the dashboard go live only when the API **and** the worker are
   both in `live` mode (the worker reports its mode; the dashboard shows the mode in force).
6. **Prove.** Every step is written to an append-only, hash-chained audit log. A simulator with hidden customer types
   measures recovered dollars against a fixed-schedule control arm.

Around the loop: an operator dashboard (summary, cases, approvals, audit, what-if, trust, timeline), a **what-if
replay** that re-runs a batch under a changed policy with bootstrap intervals, a **trust panel** (chain verification,
tamper demo, a 13-attack prompt-injection suite and a box to type your own attack), and a **self-serve page** where a
customer pays or promises a date through a signed link.

```
PayPal ──webhooks──▶ apps/api ──stores──▶ Postgres ◀──reads/writes── apps/worker
  ▲                     │ /api/*                                         │ every 5 s: events → cases,
  │                     ▼                                                │ due checks → diagnose → propose
  │               apps/dashboard (React, AG Grid, Bryntum)               │ → gate → execute → audit
  └──────────── packages/paypal (PayPalGateway: whitelist, idempotency) ◀┘
                packages/agent (the only code that calls the model)
```

## Results (simulated customers: assumptions, not proof)

The simulator's customer behaviour is an assumption (`sim/config/simulator.json`, explained in
[`sim/README.md`](sim/README.md)). Read every number next to the settings that produced it; the dashboard shows them.

- **Recovery:** about the same as a fixed reminder schedule. On the deployed batch `demo-1`, Boomerang (rules and agent
  alike) recovered 4.2 points less than the baseline on the same cases. Across 5 seeds × 12 simulator variations
  (`npm run sim:sensitivity`) the same-case uplift ranges from −10.2 to +19.2 points, median +1.3, above zero in 62% of
  runs. A single seed can show +15 or more; that is the luck of the seed.
- **Messages:** roughly half as many (demo state: 250 against 462).
- **Contacts after an opt-out:** zero in every run, against 68 to 88 per 150 cases for the fixed schedule in our runs, which keeps emailing after a STOP. Zero rule
  violations across every stored run and executed action (`npm run check:violations`).
- **Pay page:** linking reminders to the self-serve page adds about 1 to 5 points under assumed use rates.
- **Load:** 1,000 cases through the full loop, 10 simulated days: 3,768 checks in 160 s, no errors.

## Quick start: offline, no accounts needed

Needs Node 24 or newer and Docker.

```bash
git clone https://github.com/DeV-433/Boomerang.git && cd Boomerang
npm install                     # also enables the pre-push checks (.githooks)
cp .env.example .env
```

Edit `.env`: set `BOOMERANG_OFFLINE=true`, and give `OPERATOR_TOKEN`, `PAY_LINK_SECRET` and `SIM_WEBHOOK_SECRET` any
long random values (`openssl rand -hex 24`). Leave the PayPal and Groq keys empty. (`PUBLIC_BASE_URL`, used in pay-page links, defaults to the local API outside production.) Then:

```bash
npm run db:up && npm run db:migrate   # Postgres 17 on localhost:5432
npm run demo:reset                    # ~1 minute: a seeded batch, its experiment, the sweep, demo cases
npm run dev:api                       # http://localhost:3000
npm run dev:dashboard                 # open the printed URL, sign in with OPERATOR_TOKEN
```

`npm run demo:check` (with the API running) walks the whole demo and checks every beat. The demo itself is in
[`docs/demo.md`](docs/demo.md).

Ports busy? Set `PORT` (API), `VITE_API_URL` (where the dashboard finds the API), and add the dashboard's origin to
`DASHBOARD_ORIGINS`. For Postgres, map another host port in a `docker-compose.override.yml` and change `DATABASE_URL`.

## Full setup: PayPal sandbox and the agent

1. A [PayPal developer](https://developer.paypal.com) sandbox REST app: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
   `PAYPAL_ENVIRONMENT=SANDBOX`, and the sandbox business account's email as `PAYPAL_SANDBOX_MERCHANT_EMAIL`.
2. A sandbox webhook pointing at `<your API>/webhooks/paypal`, subscribed to the events in
   [`docs/verification.md`](docs/verification.md); its id is `PAYPAL_WEBHOOK_ID`. Locally, a tunnel (for example
   `cloudflared`) gives PayPal a public URL.
3. A [Groq](https://console.groq.com) key as `GROQ_API_KEY` (the free tier works; `GROQ_RPM=25`). Without one the
   rules propose every action.
4. Optional: `VITE_AG_GRID_LICENSE_KEY` and `VITE_BRYNTUM_LICENSE_KEY` (without them AG Grid shows a watermark and the
   timeline page needs Bryntum; the audit page's plain timeline does not).
5. `BOOMERANG_OFFLINE=false`, `POLICY_MODE=dry_run` to start. Run `npm run dev:worker` as well: it turns events into
   cases and works due checks. Switch to `POLICY_MODE=live` only on data you own: live sends real sandbox reminders.

Every variable is described in [`.env.example`](.env.example).

## Commands

| Command                                                                               | What it does                                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm run ci`                                                                          | Lint, type-check, migrate, all tests (also the pre-push hook)                                                      |
| `npm run dev:api` / `dev:worker` / `dev:dashboard`                                    | Run the three services locally                                                                                     |
| `npm run sim:seed -- --seed s1 --size 300 --mode offline --api http://localhost:3000` | Seed a batch (`--mode sandbox` creates real sandbox invoices)                                                      |
| `npm run sim:experiment`                                                              | Baseline on the control arm, Boomerang on the treatment arm, with intervals (add `--proposer agent` for the model) |
| `npm run sim:sensitivity`                                                             | The sweep across seeds and simulator settings                                                                      |
| `npm run sim:replay`                                                                  | What-if replay from the command line                                                                               |
| `npm run check:violations`                                                            | Count actions that broke any rule (exits 1 if any)                                                                 |
| `npm run sim:load -- --batch <offline batch>`                                         | Load check through the real loop (dry run)                                                                         |
| `npm run scan:logs -- <files>`                                                        | Scan logs for personal data and secrets                                                                            |
| `npm run demo:reset` / `demo:check` / `demo:record`                                   | Demo state, unattended demo run, fallback video                                                                    |

## Reproduce the results

```bash
npm run sim:seed -- --seed my-seed --size 300 --mode offline --api http://localhost:3000
npm run sim:experiment            # recovered dollars, uplift, 95% intervals; stored for the dashboard
npm run sim:sensitivity           # the range across 5 seeds x 12 settings
npm run check:violations
```

The same seed always gives the same batch, the same split and the same result. To run the agent instead of the rules,
add `--proposer agent` (needs `GROQ_API_KEY`; a full batch needs about 600 decisions, more than one day of Groq's free
tier, so `GROQ_API_KEYS` can list extra keys from other organisations; answers are cached, so re-runs are free).

## Deploy (Render)

[`render.yaml`](render.yaml) is a blueprint: Postgres, the API (migrations run before each deploy), the worker and the
static dashboard, in Singapore. Create it from the Render dashboard, then fill in the variables marked `sync: false`
(PayPal, Groq, `OPERATOR_TOKEN`, `PAY_LINK_SECRET`, `PUBLIC_BASE_URL`, `DASHBOARD_ORIGINS`, the dashboard's
`VITE_*`). Render deploys every push to `main`; there is no hosted CI on this account, so the pre-push hook is the gate.
Keep the worker in `dry_run` unless you mean to send reminders, and never set `GROQ_API_KEYS` there. (An API set to
`live` still sends nothing while the worker is in `dry_run`.)

Customer replies: PayPal reminder emails are answered to the merchant's inbox, not to Boomerang. Customers opt out with
the "Stop reminders about this" button on their pay page, and the operator records any other reply with **Log reply**
on the cases page (`POST /api/cases/:id/reply`, with a label or left to the classifier).

## Layout

| Path              | What lives there                                                               |
| ----------------- | ------------------------------------------------------------------------------ |
| `apps/api`        | Fastify: webhooks, `/api/*` for the dashboard, the `/pay/:token` page          |
| `apps/worker`     | The loop: events to cases, due checks, the invoice poller                      |
| `apps/dashboard`  | React 19, Vite, TanStack Query, AG Grid, Bryntum                               |
| `packages/core`   | Config, domain types, API types, pay links, the redacting logger               |
| `packages/db`     | Drizzle schema and migrations                                                  |
| `packages/policy` | The gate: a pure function, no model, no PayPal, no database                    |
| `packages/audit`  | The hash chain and its verifier                                                |
| `packages/paypal` | `PayPalGateway`: every PayPal call, whitelisted per lane, idempotent, retried  |
| `packages/agent`  | The only code that talks to the model                                          |
| `packages/cases`  | Events to cases, diagnosis, rules, the loop, the executor, the violation check |
| `sim`             | Seeder, simulator, experiment, sensitivity, replay, demo tooling               |

## Known limits

- Simulated customers: every response probability is an assumption, not a measured PayPal figure; results only mean
  something next to their settings and across the sensitivity range.
- The simulator does not model partial payments (a simulated case recovers all of its amount or nothing). The live loop
  counts a partial payment as recovered money and asks only for what is still due.
- Subscription failures are injected (`I-SIM…`): the sandbox cannot fail a payment on demand or create an outstanding
  balance. Invoice cases in sandbox mode are real PayPal invoices.
- "Invoice viewed but unpaid" is not observable through PayPal's API, so that cause is not used.
- Messages go out as PayPal's own invoice reminders, plus the audit log; there is no separate email or SMS.
- The 3-contact cap hands remaining invoice cases to a person, whose follow-up the simulator does not model.
- Free Groq tier: about 600 decisions a day per organisation; past that the worker falls back to 20B, then to rules.
- PayPal does not document whether a webhook retry carries a new transmission time; the replay window is set longer
  than PayPal's 3-day retry span for that reason.

## More

- [`BUILD_PLAN.md`](BUILD_PLAN.md): every step, how it was verified, and decisions that changed along the way.
- [`docs/demo.md`](docs/demo.md): the demo script. [`docs/verification.md`](docs/verification.md): external facts re-checked.
- [`HANDOFF.md`](HANDOFF.md): moving to another machine, secrets, guardrails.
- Licences: AG Grid Enterprise and Bryntum Scheduler are commercial (trial licences in use); everything else is open source.
