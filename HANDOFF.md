# Boomerang: handoff prompt

Paste everything below the line into Claude Code (or any coding agent) on the new machine, from the repository root.
This file holds no secrets: the values live in `.env`, which is git-ignored and must be copied over by hand (see "Secrets").

---

You are continuing **Boomerang**, a PayPal revenue-recovery agent, built step by step from `BUILD_PLAN.md` at the
repository root. Phases 0 to 10 are done, verified offline (see `BUILD_PLAN.md` "Current status"). **What is left needs the Render database, the PayPal sandbox dashboard or the project documentation**: listed under "First thing to do" below.
Read `BUILD_PLAN.md` first, especially "Current status (read this first)" and its "Decisions that differ from the text
of this plan" table: those decisions override the plan's original wording and the project documentation.

## What Boomerang is (one paragraph)

PayPal webhooks (signature-verified, stored once) open recovery cases for unpaid invoices and failed subscription
payments. Each case gets a diagnosed cause from a fixed table, then a proposed next action: from an LLM agent
(Groq `openai/gpt-oss-120b`, fallback `gpt-oss-20b`, then plain rules) choosing only from a per-lane action menu with a
validated JSON schema. A deterministic 13-rule policy gate allows, blocks or holds every proposal (rule 12 holds
money-moving actions for human approval). The executor calls PayPal with idempotency keys; every step is written to a
hash-chained audit log. Around it: a seeded simulator with hidden customer types and a control arm, a what-if replay
with bootstrap intervals, a trust panel (chain verify, prompt-injection suite), a signed customer pay page, and an
operator dashboard (React + AG Grid Enterprise + Bryntum Scheduler).

## Layout

npm workspaces: `apps/api` (Fastify 5: webhooks, `/api/*`, `/pay/:token`), `apps/worker` (job loop, invoice poller),
`apps/dashboard` (React 19, Vite, TanStack Query, AG Grid 36.2.0, Bryntum 8.0.0), `packages/core` (config, domain
types, API types, pay links), `packages/db` (Drizzle schema, migrations in `packages/db/drizzle`), `packages/policy`
(gate), `packages/audit` (hash chain), `packages/paypal` (all PayPal calls go through `PayPalGateway`),
`packages/agent` (only package that talks to the model), `packages/cases` (events to cases, diagnosis, proposals,
executor), `sim` (seeder, simulator, baseline/treatment, replay).

## Set up the new machine

Prerequisites: git, Node **>= 24** (built with 26), Docker (for local Postgres 17), `psql` (handy for inspecting the
Render database read-only), and Chromium or Chrome if you want headless screenshots of the dashboard.

```bash
git clone https://github.com/DeV-433/Boomerang.git && cd Boomerang
npm install                 # also sets core.hooksPath=.githooks (the pre-push CI gate)
# copy the .env from the old machine into the repo root (see "Secrets"), or start from .env.example
npm run db:up               # local Postgres on localhost:5432 (user/password/db: boomerang)
npm run db:migrate
npm run ci                  # lint, type-check, migrate, all tests: must pass before any push
npm run dev:api             # http://localhost:3000
npm run dev:dashboard       # Vite dev server; sign in with OPERATOR_TOKEN
npm run dev:worker          # only in POLICY_MODE=dry_run, see the guardrails
```

Every package loads the repo's `.env` itself (`packages/core/src/env.ts`, `process.loadEnvFile`). Local
`DATABASE_URL` should point at the Docker database, e.g. `postgres://boomerang:boomerang@localhost:5432/boomerang`.
Tests use `TEST_DATABASE_URL` or `DATABASE_URL`. In `.env`, quote any value that contains spaces (the pre-push hook
also sources the file with bash).

## Secrets (in `.env`, never in git, never printed)

Copy `.env` from the old machine over a private channel. Check keys by length only, never echo them.

| Variable                                                         | What it is                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`                       | PayPal **sandbox** REST app                                                                                  |
| `PAYPAL_ENVIRONMENT`                                             | `SANDBOX`                                                                                                    |
| `PAYPAL_WEBHOOK_ID`                                              | the sandbox webhook pointing at the deployed API (16 event types)                                            |
| `PAYPAL_SANDBOX_MERCHANT_EMAIL`, `PAYPAL_SANDBOX_CUSTOMER_EMAIL` | sandbox business account and the original US personal account                                                |
| `POLICY_MODE`                                                    | `dry_run` locally unless a step says otherwise                                                               |
| `PAY_LINK_SECRET`                                                | HMAC secret for pay links; must equal the value on the Render API and worker                                 |
| `SIM_WEBHOOK_SECRET`                                             | signs the simulator's synthetic webhooks                                                                     |
| `DATABASE_URL`                                                   | local Docker Postgres                                                                                        |
| `RENDER_DATABASE_URL`                                            | external URL of the Render Postgres, for read-only inspection and for seeding/simulating `demo-1`            |
| `GROQ_API_KEY`                                                   | Groq key (free tier, shared with the Render worker)                                                          |
| `GROQ_API_KEYS`                                                  | local only: teammates' Groq keys, comma-separated, rotated by simulations and evals; **never set on Render** |
| `GROQ_RPM`                                                       | request pacing (25)                                                                                          |
| `OPERATOR_TOKEN`                                                 | bearer token for `/api/*`; typed into the dashboard                                                          |
| `DASHBOARD_ORIGINS`                                              | CORS allow-list for the API                                                                                  |
| `PUBLIC_BASE_URL`, `MERCHANT_NAME`                               | pay-page base URL and the merchant name it shows                                                             |
| `VITE_AG_GRID_LICENSE_KEY`                                       | AG Grid Enterprise key (also on the Render static site)                                                      |
| `VITE_BRYNTUM_LICENSE_KEY`                                       | Bryntum Scheduler trial licence, ends 2026-12-24 (a "Trial" badge is expected)                               |
| `GEMINI_API_KEY`, `GEMINI_RPM`                                   | unused leftovers from before the switch to Groq                                                              |

## Deployment (Render, blueprint `render.yaml`)

- API `boomerang-api`: https://boomerang-api-rgd8.onrender.com (`/healthz` public; preDeploy runs migrations)
- Worker `boomerang-worker`: runs the loop in **`dry_run`**
- Dashboard (static site): https://boomerang-dashboard-abv8.onrender.com
- Postgres `boomerang-db`: holds the demo batch `demo-1` (id `f62bff2d-74dd-45fc-ab03-95a1b774fc9b`)
- Render auto-deploys every push to `main`. GitHub Actions is unavailable on this account, so `.githooks/pre-push`
  (lint, type-check, migrate, tests against local Postgres) is the only gate. Start Postgres before pushing.

## How to work

- One step at a time. Pause whenever input
  from the user is needed (accounts, keys, approving something in the PayPal sandbox or the dashboard).
- Prove each step's _Done when_ against the real PayPal sandbox and the deployed Render services where possible, then
  tick it in `BUILD_PLAN.md` with a short italic note of what was verified. Keep "Current status" current.
- Commit and push after each step, with the step id in the message (e.g. `feat(9.4): ...`, `docs(plan): ...`), ending
  with the agreed co-author trailer.
- Report results honestly. **Never tune the simulator or the policy to make results look better.** Known results:
  rules-only treatment is -4.2 points against the same-case baseline (subscriptions +22, invoices about -6 because the
  3-contact cap hands cases to a person the simulator does not model); the agent matches the rules; the pay page adds
  +4.9 points under assumed use rates. These are findings, not bugs.
- The repository is public: no secrets, tokens or database URLs in code, docs or commit messages.

## Guardrails (do not break these)

1. Never re-seed `demo-1` against any database other than Render's: the PayPal idempotency ledger is per database, so
   the 170 real sandbox invoices would be created twice.
2. Never run the worker or `pollInvoices` locally in `live` mode: it would send reminders for all 170 `demo-1`
   invoices. For live checks use `packages/cases/scripts/live-e2e.ts`, or
   `packages/cases/scripts/create-overdue-invoice.ts <dollars>` (the Render poller opens an organic case within
   5 minutes).
3. Do not call `startBatch` on `demo-1` unless the user asks for the demo run. Control-arm cases are never worked.
4. Keep `GROQ_API_KEYS` off Render. A full agent simulation of `demo-1` needs ~600K tokens on 120B, more than a day of
   the free tier; re-runs are free from the `model_calls` cache.
5. Transactions that lock rows and write audit entries must use `auditedTransaction`.
6. All PayPal calls go through `PayPalGateway` (it works around Agent Toolkit 1.11.0 bugs); only `packages/agent`
   talks to the model.

## Unfinished from earlier phases (finish when the sandbox allows)

- 2.9, 8.5 and 8.6 were verified in the real sandbox on 2026-11-10 (see `BUILD_PLAN.md`). The original personal
  account has a payment method again, so subscription `I-7AV61N6EYGP5` (daily $9.99) keeps charging it; cancel it in
  the sandbox if it gets in the way. The end-to-end test for that chain is `apps/api/test/retry.test.ts`.
- **2.6** (PayPal's own invoice reminder suppressed): only observable when an invoice reaches its due date.

## Facts that later steps depend on

- Groq free tier per model: 1K requests/day, 8K tokens/min, 200K tokens/day as a rolling window; the Render worker
  shares `GROQ_API_KEY`, so heavy local runs push its decisions to 20B and then to the rules.
- PayPal: `MARKED_AS_PAID` counts as paid; `PAYMENT.SALE.COMPLETED` carries the subscription id in
  `resource.billing_agreement_id`; invoices to recipients inside India are blocked, so sandbox invoices go to US
  `example.com` addresses. A second US personal sandbox account exists for paying invoices.
- Audit hashing: dates hash as ISO strings; entries before 2026-11-10 get a disclosed legacy check.
- Dashboard grids expose `window.__casesGrid` / `window.__auditGrid` only in non-production builds
  (`vite build --mode test`). In headless Chromium, expanding an AG Grid detail row needs two chevron clicks
  (pre-existing, not a regression).
- Useful commands: `npm run sim:seed`, `npm run sim:baseline`, `npm run sim:treatment`, `npm run sim:replay`
  (see `sim/README.md`); `packages/paypal/scripts/sandbox-check.ts` for a live PayPal round trip.

## First thing to do

Run `npm run ci`, check `https://boomerang-api-rgd8.onrender.com/healthz`, read `BUILD_PLAN.md` "Current status",
then finish the items that need secrets or accounts (they were built on a machine without `.env`):

1. Against the Render database (read-only except the sweep row): `DATABASE_URL=$RENDER_DATABASE_URL npm run sim:sensitivity`
   so the deployed summary shows the range (9.2), and `npm run check:violations -- --database render` (9.4).
   Do **not** run `demo:reset` there (it refuses anyway) or re-seed `demo-1`.
2. Sign in to the deployed dashboard and confirm demo-1's summary shows the uplift interval and settings (9.1, 9.3).
3. In the PayPal sandbox dashboard: the webhook still targets the Render API with every event subscribed, and, by
   failing one delivery on purpose, whether a retry carries a new `paypal-transmission-time` (9.9).
4. 10.5: bring the final numbers into the external project documentation (README and `docs/demo.md` have them).
5. The unattended runner (`demo:check`) resets a local database, so it cannot run against Render; walk
   `docs/demo.md` by hand on the deployed dashboard instead.

Offline demo on any machine: `npm run demo:reset`, `BOOMERANG_OFFLINE=true npm run dev:api`, `npm run dev:dashboard`.
