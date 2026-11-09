# Boomerang: Build Plan

One fragment at a time. Every step is small enough to build, test and commit on its own, and each has a **Done when** check so you know it is finished before moving on.

**Stack:** TypeScript, Node + Fastify, Postgres (Drizzle), Vitest, React + Vite, AG Grid, Bryntum Scheduler, Groq API with OpenAI's gpt-oss models (in place of the Claude API originally planned; Gemini was tried first), PayPal sandbox + Agent Toolkit, Render.

**Legend:** `[M]` must-have · `[S]` should-have · `[C]` could-have · `★` standout feature (what-if replay, trust panel, self-serve page)

---

## Current status (read this first)

Last updated 2026-11-09. Phases 0 to 5 are done (checkpoints **CP1** to **CP4** reached). Open from earlier phases: 2.6 (PayPal's own reminder suppression, only observable on a due date) and 2.9 (balance capture, waiting for a real failed subscription payment after 10:00 UTC on 2026-11-10). **Next: Phase 6** (dashboard); 6.5 needs the AG Grid Enterprise key. Known result to improve later: the agent matches the rules (−4.2 points against the baseline on the same cases), mainly from the 3-contact cap on invoices.
Ticked boxes below were checked against their *Done when*; an unticked box with a note in _italics_ is partly done.

Decisions that differ from the text of this plan:

| Topic | What we actually do |
| --- | --- |
| Model | Groq (`GROQ_API_KEY`), called with plain `fetch` from `packages/agent` only. Decisions and reply classification: `openai/gpt-oss-120b`; drafting and fallback: `openai/gpt-oss-20b` (the only production Groq models with strict JSON-schema output). Read "Claude" in later steps as "the model". Gemini was used first and dropped on 2026-11-09: `gemini-3.8-flash` was overloaded and the key's per-minute quota stalled a simulation at ~3 calls/min. |
| Model limits | The key is on Groq's free tier; its headers report, per model, 1K req/day and 8K tokens/min and 200K tokens/day, which is enforced as a rolling window (a full `demo-1` agent run needs ~600 decisions, ~600K tokens on 120B). The Render worker shares the key, so after a simulation drains 120B the worker's decisions come from 20B, then the rules. A full agent simulation of `demo-1` needs ~430 decisions (~500K tokens), so it may span more than a day's allowance; re-runs are free from the `model_calls` cache. |
| Extra Groq keys | Teammates' keys from their own Groq organizations go in local `.env` as `GROQ_API_KEYS` (comma-separated). Simulations and evals rotate across `GROQ_API_KEY` plus these; a key that hits a limit is set aside until it resets. The deployed worker uses `GROQ_API_KEY` only; never put `GROQ_API_KEYS` on Render. |
| Dashboard access | Not in the original plan: `/api/*` requires `OPERATOR_TOKEN` (Bearer), typed once into the dashboard and kept in `sessionStorage`. `/healthz` and the webhooks stay public. CORS allows only `DASHBOARD_ORIGINS` (plus local Vite dev outside production). |
| Scope | No cut line: every phase is in scope. |
| CI (1.2) | GitHub Actions cannot run on this account. `.githooks/pre-push` runs lint, type-check, migrations and all tests and blocks the push on failure. `npm install` enables it. Start Postgres first (`npm run db:up`). |
| Deploys | Render deploys every push to `main` (`autoDeployTrigger: commit`), so the pre-push hook is the only gate. |
| Extra package | `packages/cases` turns stored PayPal events into cases (started in 3.4; step 4.3 extends it). |
| Sandbox customers | PayPal blocks invoices to recipients inside India. Seeded invoices go to US `example.com` addresses; the sandbox *customer* account is a US personal account. |
| Diagnosis (4.5) | "Viewed but unpaid" is not observable (PayPal's API does not report invoice views), so the invoice lane uses `overdue_unresponsive` ("contacted, no reply"). |
| Who the loop works | Never control-arm cases. A seeded batch's treatment cases only after `startBatch` (no batch has been started yet). Organic cases (not in a batch) are worked as soon as they open. |
| Live run (verified 2026-11-09) | The Render worker in `live` mode worked organic invoice INV2-4CYP-PW8D-P9Q7-YJYF ($40): held at 12:02 UTC (07:00 in New York, outside contact hours), re-checked at 15:00 UTC, agent proposed `send_reminder`, gate allowed, `cancel_invoice_auto_reminder` and `send_invoice_reminder` succeeded first try; audit trail complete; next check 2026-11-12. The decision came from the 20B fallback because a simulation had used up 120B's daily token limit on the same key; use a separate key for simulations. |
| Locks | Any transaction that locks rows and writes audit must use `auditedTransaction` (takes the chain lock first); mixing orders deadlocks. |

Facts found while building that later steps depend on:

- Recording an outside payment leaves an invoice `MARKED_AS_PAID` (not `PAID`), yet `INVOICING.INVOICE.PAID` still fires. Treat both as paid (4.3, 4.15).
- `PAYMENT.SALE.COMPLETED` carries the sale id in `resource.id`; the subscription id is `resource.billing_agreement_id` (4.3).
- Invoice events nest the invoice under `resource.invoice`; subscription events use `resource` directly.
- Agent Toolkit 1.11.0: its client never refreshes tokens, `run()` hides errors, `create_invoice` has no due date. `packages/paypal` works around all three; always call PayPal through `PayPalGateway`.
- The sandbox cannot create an outstanding subscription balance on demand (PATCH can only lower one).

The demo batch **`demo-1`** (300 cases: 170 real backdated sandbox invoices, 130 simulated subscriptions, split
150/150) lives in the **deployed Render database**. Do not re-seed `demo-1` against another database: the PayPal
idempotency ledger is per database, so the 170 invoices would be created twice. Baseline on its control arm (CP2):
$46,472.50 of $71,087.62 recovered (65.4%). Rule-based treatment (CP3): 56.5%, which is -8.9 points against the
control arm but -4.2 points against the baseline on the *same* cases (the arms differ by luck). Subscriptions gain
+22 points (card-update requests); invoices lose ~6 points because the 3-contact cap hands cases to a person, whose
follow-up the simulator does not model. Treat this as a finding about the policy, not a bug to tune away.
Render runs the worker in `dry_run`; a live round trip was verified locally with
`npx tsx packages/cases/scripts/live-e2e.ts` (real reminder sent, payment closed the case, chain verified). Useful commands: `npm run ci`, `npm run sim:seed`, `npm run sim:baseline`,
`npm run sim:treatment` (see `sim/README.md`), `packages/paypal/scripts/sandbox-check.ts` for a live PayPal round trip.

---

This plan accompanies the project documentation ("Boomerang — Project Documentation"). Section references below point to that document: section 5 for the PayPal integration, section 8 for the diagnosis table, and the policy section for the gate rules.

## How to work with this plan

1. Pick the next unchecked step. Do not start a step whose dependencies are unchecked.
2. Build only that step. Write its test or check first when the step says so.
3. Run the **Done when** check. Commit with the step ID in the message, e.g. `feat(2.3): token manager`.
4. Tick the box. Move on.

Prompt template for asking Claude to build one step:

```
Build step <ID> from BUILD_PLAN.md: "<title>".
Constraints: only touch the files this step needs; keep the policy gate and audit
writer free of model calls; add tests; stop when the Done-when check passes.
```

---

## Checkpoints (ship points)

| Checkpoint | After phase | What works |
| --- | --- | --- |
| **CP1** Live pipe | 1 | PayPal sandbox event reaches the deployed API and is stored once |
| **CP2** Baseline | 3 | A seeded batch runs under the fixed-schedule baseline and reports recovered dollars |
| **CP3** No-AI loop | 4 | A case goes from detected to recovered with gate and audit, no model involved |
| **CP4** Agent | 5 | Treatment arm runs on the agent; every bad proposal is blocked in tests |
| **CP5** Operator view | 6 | Operator can see cases, approve a held action, read the audit trail |
| **CP6** Standout | 7 | What-if replay, trust panel and self-serve page all work |
| **CP7** Demo ready | 10 | Demo script runs twice in a row unattended |

No cut line: every phase is in scope (decided 2026-11-09, step 0.7).

---

## Phase 0: Accounts and decisions

- [x] **0.1 [M]** Create a PayPal developer account and a **sandbox app**; save client ID and secret in a password manager. *Done when:* you can fetch a sandbox access token with curl.
- [x] **0.2 [M]** Create two sandbox accounts: one merchant (business), one customer (personal). *Done when:* you can log in to both in the sandbox.
- [x] **0.3 [M]** Create a Render account and connect your Git host. *Done when:* Render can see the repository.
- [x] **0.4 [M]** Get an Anthropic API key. *Done when:* a one-line script gets a model reply.
- [x] **0.5 [M]** Check AG Grid and Bryntum licensing: which features need paid editions (row grouping with totals, detail rows) and what the trial limits are. *Done when:* a short note lists "free vs paid" for each feature you plan to use.
- [x] **0.6 [M]** Decide message delivery: PayPal reminder tool plus logging only (recommended), or also real email. *Done when:* the choice is written in the README.
- [x] **0.7 [M]** Write down the hackathon deadline and judging criteria. *Done when:* the cut line above is adjusted to fit the time left.

---

## Phase 1: Foundation (to CP1)

- [x] **1.1 [M]** Create the monorepo: `apps/api`, `apps/worker`, `apps/dashboard`, `packages/core`, `packages/policy`, `packages/paypal`, `packages/agent`, `packages/audit`, `sim/`. Set up TypeScript, lint, Vitest. *Done when:* `npm test` runs (even with zero tests) in every package.
- [x] **1.2 [M]** Add a CI script that runs lint, type-check and tests. *Done when:* a failing test turns CI red. _(Local pre-push hook; GitHub Actions unavailable on this account.)_
- [x] **1.3 [M]** Local Postgres via Docker Compose and a migration tool. *Done when:* `npm run db:migrate` creates an empty database.
- [x] **1.4 [M]** Migration: `customers`, `cases`, `events`. *Done when:* tables exist and `events.paypal_event_id` is unique.
- [x] **1.5 [M]** Migration: `actions`, `approvals`, `policies`. *Done when:* foreign keys to `cases` work in a test.
- [x] **1.6 [M]** Migration: `audit_log` with `prev_hash` and `hash`, plus a database role that can insert and select but not update or delete. *Done when:* a test confirms update and delete are rejected for that role.
- [x] **1.7 [M]** Fastify skeleton with `GET /healthz`. *Done when:* health check returns 200 with a database ping.
- [x] **1.8 [M]** Webhook route `POST /webhooks/paypal` that stores the raw body and headers and returns 200 fast. *Done when:* a posted sample is stored.
- [x] **1.9 [M]** Signature verification using PayPal's webhook verification (needs the webhook ID). *Done when:* a valid test event passes and a tampered one returns 400.
- [x] **1.10 [M]** Deduplicate by `paypal_event_id`. *Done when:* posting the same event twice stores one row.
- [x] **1.11 [M]** Write `render.yaml` for API, worker, dashboard and database. *Done when:* Render accepts the Blueprint (check field names against Render's current spec).
- [x] **1.12 [M]** Deploy to Render with secrets set in the dashboard, not in the repository. Variables: `DATABASE_URL` (from Render), `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENVIRONMENT=SANDBOX`, `GROQ_API_KEY` (was `GEMINI_API_KEY`), `POLICY_MODE` (`dry_run` or `live`), and a signing secret for pay-page links. Use an always-on plan so webhooks are not missed, and confirm the Postgres plan's expiry terms. *Done when:* `/healthz` works on the public URL.
- [x] **1.13 [M]** Register the public URL as a webhook endpoint in the PayPal dashboard; subscribe to the subscription and invoicing events. *Done when:* a sandbox action (for example, creating an invoice) produces a stored event on the deployed API. **CP1.**

---

## Phase 2: PayPal integration layer

- [x] **2.1 [M]** Token manager: fetch, cache, refresh before expiry, retry once on auth failure. *Done when:* a test with a fake clock refreshes at the right time.
- [x] **2.2 [M]** Install the PayPal Agent Toolkit, pinned to an exact version. *Done when:* the installed tool list prints at startup.
- [x] **2.3 [M]** Tool whitelist config per lane (see section 5 of the documentation). *Done when:* asking for a non-whitelisted tool throws.
- [x] **2.4 [M]** Wrapper `listInvoices`, `getInvoice` (read-only). *Done when:* returns a sandbox invoice you created by hand.
- [x] **2.5 [M]** Wrapper `sendInvoiceReminder` with an idempotency key. *Done when:* calling twice with the same key sends once.
- [ ] **2.6 [M]** Wrapper `cancelInvoiceAutoReminder`. *Done when:* in the sandbox, PayPal's own reminder no longer fires for that invoice (verify by observation or event). _(PayPal accepts the cancel (sandbox, 2026-11-09); suppression only observable on a due date, re-check in Phase 3.)_
- [x] **2.7 [M]** Wrapper `recordPaymentForInvoice`. *Done when:* an invoice flips to paid and a paid event arrives.
- [x] **2.8 [S]** Wrapper `showSubscriptionDetails` (read-only). *Done when:* returns status and failed-payment count for a sandbox subscription.
- [ ] **2.9 [S]** Direct REST wrapper for capturing a subscription's outstanding balance (not in the toolkit list). *Done when:* it works on a sandbox subscription with a balance. _(Request accepted by PayPal, refused only with ZERO_OUTSTANDING_BALANCE; sandbox cannot create a balance on demand.)_
- [x] **2.10 [M]** Contract tests: one per whitelisted tool, checking name and argument shape. *Done when:* upgrading the toolkit version would fail the tests if a name changes.
- [x] **2.11 [M]** Error handling: log full error bodies, back off and retry on rate limits and 5xx. *Done when:* a simulated 429 retries then succeeds.

---

## Phase 3: Seeding, simulator and baseline (to CP2)

- [x] **3.1 [M]** Define the customer-type model: would-pay-after-nudge, needs-card-update, promises-then-pays, slow-payer, disputer, opts-out. Write the response probabilities in a single config file. *Done when:* the config is documented and loaded by tests.
- [x] **3.2 [M]** Seeded random generator (fixed seed). *Done when:* two runs with the same seed give identical output.
- [x] **3.3 [M]** Seeder: create about 300 sandbox invoices and subscription cases with varied amounts and causes. *Done when:* cases appear in the database and in PayPal.
- [x] **3.4 [M]** Failure injector: create signed failed-payment webhook payloads for subscriptions the sandbox will not fail naturally, marked as simulated. *Done when:* the API accepts them and opens cases.
- [x] **3.5 [M]** Assignment: stratified random split into control and treatment by lane and amount band. *Done when:* both arms have similar size and amount totals.
- [x] **3.6 [M]** Simulator responder: given a case, its customer type and the contact made, return pay, promise, ignore, dispute or opt-out. *Done when:* unit tests show each type reacts as configured.
- [x] **3.7 [M]** Baseline runner: fixed-schedule generic reminders plus PayPal's retry behavior, no diagnosis. *Done when:* a full seeded batch runs and ends with a recovered amount.
- [x] **3.8 [M]** Metrics module: recovered amount, recovery rate, contacts per recovered dollar, time to recovery. *Done when:* tests compare against hand-calculated values. **CP2.**

---

## Phase 4: Core loop without AI (to CP3)

- [x] **4.1 [M]** Case state machine with legal transitions only. *Done when:* an illegal transition throws and every legal one is tested.
- [x] **4.2 [M]** Audit writer with hash chaining. *Done when:* each entry stores the previous hash and a verification function passes on a chain of 100 entries.
- [x] **4.3 [M]** Case opener from stored events (subscription failed, invoice paid, cancelled, dispute). *Done when:* each event type produces the expected case change.
- [x] **4.4 [M]** Overdue poller in the worker: list invoices, compare due dates, open cases. *Done when:* a past-due sandbox invoice opens one case, not two.
- [x] **4.5 [M]** Rule-based diagnosis returning a cause label for every case type. *Done when:* a table of example inputs maps to the expected labels.
- [x] **4.6 [M]** Action menus per lane as typed enums. *Done when:* the type system rejects an unknown action.
- [x] **4.7 [M]** Rule-based proposer (placeholder for the agent): maps cause to first action using the table in section 8. *Done when:* every cause has a proposal.
- [x] **4.8 [M]** Policy gate rules 1 to 3 (resolved, dispute, opt-out). *Done when:* unit tests pass for each.
- [x] **4.9 [M]** Policy gate rules 4 to 8 (kill switch, whitelist, caps, spacing, contact hours). *Done when:* unit tests pass, including time-zone cases.
- [x] **4.10 [M]** Policy gate rules 9 to 12 (amount threshold, confidence, message lint hook, sensitive actions). *Done when:* unit tests pass.
- [x] **4.11 [M]** Rule-order test: a property test that the first failing rule always decides. *Done when:* shuffled inputs never change the verdict order.
- [x] **4.12 [M]** Executor: translate an allowed action into a whitelisted PayPal call, record request, response and idempotency key. *Done when:* a gated reminder is sent and logged.
- [x] **4.13 [M]** Pre-execution re-check: re-read case state right before the call; a paid event overrides. *Done when:* a test where payment arrives mid-flight sends nothing.
- [x] **4.14 [M]** Follow-up scheduler in the worker reading due jobs from the database; cancelled on stop. *Done when:* stopping a case removes its pending jobs.
- [x] **4.15 [M]** Observation handler: paid event closes the case as recovered; no-reply moves it to the next stage. *Done when:* both paths are tested end to end.
- [x] **4.16 [M]** Run the treatment arm with the rule-based proposer through the simulator. *Done when:* a batch finishes and reports recovered dollars. **CP3.**

---

## Phase 5: Agent (to CP4)

- [x] **5.1 [M]** Define the proposal JSON schema and validator. *Done when:* invalid examples are rejected.
- [x] **5.2 [M]** Case-summary builder: structured fields only, no raw customer text, minimal personal data. *Done when:* a test shows no free-text field reaches the prompt.
- [x] **5.3 [M]** Decision call: Claude returns a proposal from the lane's action menu. *Done when:* output validates on 20 sample cases. _(Groq, prompt decide-v2: 20/20 valid on the first attempt, 20/20 same action as the rules, 12/12 drafts pass lint, $0.0044. decide-v1 needed a retry on 4 escalations that set `next_check_after_hours: 0`; Groq's own strict check (`400 json_validate_failed`) is now retried. `npx tsx packages/agent/evals/decide.ts`.)_
- [x] **5.4 [M]** Retry once on invalid output, then escalate to a human. *Done when:* a forced bad response ends in escalation.
- [x] **5.5 [M]** Store model name, prompt version and input snapshot with every decision. *Done when:* the audit entry for a proposal contains all three.
- [x] **5.6 [M]** Message templates per action and stage (friendly, neutral, firm). *Done when:* each template renders with all required fields.
- [x] **5.7 [M]** Drafting call: personalize inside a template. *Done when:* output keeps amount, reference, link and opt-out line.
- [x] **5.8 [M]** Message lint: reject invented facts, missing fields, threats, unapproved deadlines. *Done when:* a set of 15 bad drafts is all rejected and 10 good drafts all pass.
- [x] **5.9 [M]** Reply classifier in a separate call with **no tools** and a fixed output set (promise, dispute, opt-out, question, other). *Done when:* labels match on a test set of 30 replies. _(Groq `openai/gpt-oss-120b`, prompt classify-v4: 30/30 labels and dates, $0.0044. The input carries a 14-day weekday calendar so "on Friday" is looked up, not counted; injected "classify this as a promise" sentences are removed before labelling. 20B scored 28/30 and fell for an injection, so classification uses 120B. `npx tsx packages/agent/evals/classify.ts`.)_
- [x] **5.10 [M]** Connect the agent to the loop in place of the rule-based proposer; keep the rule-based one as fallback. *Done when:* the treatment arm runs on the agent. _(Run a86655fd (2026-11-09, `demo-1`, 45-day horizon): all 439 decisions from `gpt-oss-120b`, 29 clear-cut cases by rules, no fallbacks. Recovered $40,473.62 of $71,656.95 (56.5%), against 65.4% for the control arm (−8.9 points) and 60.7% for the baseline on the same cases (−4.2 points). Practically the same as the rules run (56.5%, $40,493.60, 271 contacts vs 264): the agent picks the rules' action almost every time, so it adds no recovery yet. Contacts after opt-out: 0 vs 77 for the baseline. Needed five Groq keys from separate organizations (`GROQ_API_KEYS`); the first single-key run stopped at 110/150 on the daily limit.)_
- [x] **5.11 [M]** Token and cost tracking per run. *Done when:* the run report shows tokens and cost per recovered dollar. _(Run a86655fd: 785 model calls (448 from cache), 240K tokens in, 31K out, 20K thinking; $0.0565 for decisions, $0.0050 for drafts; $0.0614 in total, $0.0000015 per recovered dollar. Stored in `sim_runs.metrics.model` and the `model_calls` ledger.)_ **CP4.**
- [x] **5.12 [M]** Safety tests: attempt to make the agent propose a non-menu action, a refund, or a policy change. *Done when:* the gate or validator blocks every attempt. **CP4.**

---

## Phase 6: Operator dashboard (to CP5)

- [x] **6.1 [M]** Dashboard app skeleton (React, Vite, routing, API client). *Done when:* it loads and calls `/healthz`. _(`apps/dashboard`: React 19, Vite 8, React Router, TanStack Query. Deployed at https://boomerang-dashboard-abv8.onrender.com; verified in headless Chromium: loads, deep links work, the badge shows "API healthy" through CORS (`DASHBOARD_ORIGINS`).)_
- [x] **6.2 [M]** API: `GET /api/summary`. *Done when:* returns at-risk, recovered, rate and control comparison. _(Behind `OPERATOR_TOKEN`. Live totals per arm for a batch, organic cases, and the latest simulated control run against the agent run (or `?treatmentRun=`). Deployed: `demo-1` simulated control 65.4% vs agent 56.5% (−8.9 points), matching the stored runs; live arms $0 recovered as the batch is not started.)_
- [x] **6.3 [M]** Summary screen. *Done when:* numbers match the metrics module for a seeded run. _(Sign-in with the operator token, stat tiles, a recovered-vs-at-risk meter per arm, the full metrics table and a treatment-run picker. On the deployed dashboard every `demo-1` number equals the stored `computeMetrics` output and the CLI report: control $46,472.50 (65.4%), agent $40,473.62 (56.5%), −8.9 points, contacts 456 vs 264, after opt-out 77 vs 0. Checked at 1200 px, 390 px (no sideways scroll) and in dark mode.)_
- [x] **6.4 [M]** API: `GET /api/cases` with paging, filters and sorting. *Done when:* server-side paging works on 300 cases. _(Offset/limit up to 500, 10 sort fields with nulls last and a stable tie-break, filters for lane, state, cause (incl. none), arm, batch, open, paused and a literal text search; `GET /api/cases/groups?by=cause|state|lane|arm` for group totals (6.6). Tested on 300 seeded cases (no overlap, no gap, sort across pages, group sums); deployed: 301 real cases in 4 pages, ~0.26 s each.)_
- [x] **6.5 [M]** AG Grid cases screen with columns: customer, lane, amount, cause, state, stage, last contact, next check, recovered amount; row actions to pause, escalate and open the audit trail. *Done when:* sort, filter and paging work. _(AG Grid Enterprise 36.2.0, server-side row model: sort, set filters, search and paging all run in the API. Row actions call `POST /api/cases/:id/pause` and `/escalate` (audited as `operator`). Checked in headless Chromium: sort by amount matches the API across pages, the state filter gives 271 approval cases, Pause flips the row to "approval (paused)" and writes the audit entry. Deployed with the licence: no watermark, no console errors, 301 cases in 7 pages.)_
- [x] **6.6 [S]** Grouping by cause and state with summed amounts. *Done when:* group totals match the API (check edition limits from step 0.5). _(Row grouping is an Enterprise feature (licensed). Group by cause, state, lane or arm from the group bar; each level comes from `GET /api/cases/groups` with parent keys as filters. In the browser the 8 cause groups' counts and sums equal the API exactly; expanding "approval" loads its 271 cases 50 at a time.)_
- [x] **6.7 [M]** API: `GET /api/cases/:id/audit`. *Done when:* returns an ordered trail. _(Trail in chain order (entry id, since `at` repeats inside one transaction). Plus `GET /api/audit`: the whole log, newest first, paged, filtered by kind, case and actor, searched across reference, actor and entry data. Tested with real audited pause, resume and escalate.)_
- [x] **6.8 [M]** AG Grid audit screen with detail rows showing a case timeline. *Done when:* expanding a row loads that case's entries in order. _(Server-side master grid over the whole log (search, kind filter, newest first) with Enterprise master/detail; a row expands into its case's trail from `GET /api/cases/:id/audit`, each entry described in one line with the full record on hover. "Audit" in the cases grid opens `/audit?case=<id>` with the trail expanded. Deployed: the organic invoice's 9 entries (171 to 179) appear in chain order, showing the 07:00 New York hold, the agent proposal and the sent reminder.)_
- [x] **6.9 [S]** API: `GET /api/approvals` and `POST /api/approvals/:id/decision`. *Done when:* approve, edit and reject each change case state correctly. _(Queue rows carry the draft, the proposer's reason and confidence, the gate's reasons and the customer's latest reply verbatim in its own field. Decisions go through `decideApproval` (re-gated) with the API's PayPal gateway and POLICY_MODE. An edited body must pass the message lint first (422 with the issues, nothing changes). Tested over a fake PayPal: approve sends and returns the case to awaiting, edit sends the operator's wording, reject stops the case and sends nothing; a second decision is 409.)_
- [ ] **6.10 [S]** AG Grid approval queue with draft view and approve, edit, reject buttons; customer text shown in a labelled block. *Done when:* approving a held case sends it.
- [ ] **6.11 [M]** Global pause button and `POST /api/system/pause`. *Done when:* pausing stops all new actions within one worker cycle. **CP5.**
- [ ] **6.12 [S]** Live updates by polling or server-sent events. *Done when:* a new case appears without reloading.

---

## Phase 7: Standout features (to CP6)

### 7A ★ What-if replay

- [ ] **7A.1 [M]** Replay reader: load stored events in order for a batch. *Done when:* replaying with no changes reproduces the original outcomes exactly.
- [ ] **7A.2 [M]** Injectable clock and random source so replays are deterministic. *Done when:* two replays are byte-identical.
- [ ] **7A.3 [M]** Dry executor: same interface as the real one, makes no PayPal calls, uses the simulator for responses. *Done when:* a replay sends nothing to PayPal.
- [ ] **7A.4 [M]** Policy overrides as input (caps, spacing, hours, thresholds). *Done when:* changing a cap changes the number of contacts in the replay.
- [ ] **7A.5 [M]** Run two replays (current and changed policy) and diff recovered dollars, contacts and escalations. *Done when:* the diff is correct on a hand-built example.
- [ ] **7A.6 [M]** Bootstrap confidence interval for the difference. *Done when:* the interval is reported and tested on known data.
- [ ] **7A.7 [S]** API: `POST /api/whatif`. *Done when:* returns the diff in under a few seconds for 300 cases.
- [ ] **7A.8 [S]** What-if screen: sliders and inputs for key policy settings, side-by-side results, interval shown. *Done when:* changing a slider updates the result.
- [ ] **7A.9 [S]** Save and name scenarios. *Done when:* a saved scenario reloads with the same result.

### 7B ★ Trust panel

- [ ] **7B.1 [M]** Chain verification function: walk the audit log and report the first broken link. *Done when:* a clean chain passes and an edited row is detected at the right position.
- [ ] **7B.2 [M]** API: `GET /api/audit/verify`. *Done when:* returns pass or the broken position.
- [ ] **7B.3 [M]** Demo-only tamper script that edits a row in a copy of the database. *Done when:* running it makes verification fail, and the real database is untouched.
- [ ] **7B.4 [M]** Injection test suite: at least 10 hostile customer replies (override instructions, ask for refunds, ask to change policy, hide commands in invoice notes). *Done when:* the suite runs automatically.
- [ ] **7B.5 [M]** Assertions: no hostile input changes the action menu, policy, tool access or any PayPal call. *Done when:* all suite cases pass.
- [ ] **7B.6 [S]** API: `POST /api/trust/attack` with an optional custom reply, returning classification, gate verdict and "tool calls made: none". *Done when:* a typed attack returns a clean result.
- [ ] **7B.7 [S]** Trust panel UI: integrity badge with a Verify button, live attack input, scoreboard of suite results. *Done when:* the tamper demo turns the badge red and the attack input shows the block.
- [ ] **7B.8 [C]** Export a per-case audit receipt (PDF or CSV) including the chain hash. *Done when:* the file opens and the hash matches the log.

### 7C ★ Self-serve pay-or-promise page

- [ ] **7C.1 [M]** Signed link generator: HMAC token with case ID and expiry. *Done when:* a tampered or expired token is rejected.
- [ ] **7C.2 [M]** Public route `GET /pay/:token` showing amount, reference and merchant name, with no other personal data. *Done when:* the page loads with a valid token only.
- [ ] **7C.3 [M]** Pay-now action using the PayPal payment link or invoice QR. *Done when:* paying in the sandbox fires the paid event and closes the case.
- [ ] **7C.4 [M]** Promise action: date picker limited by policy (for example, within N days). *Done when:* submitting writes a promise event and sets the next check.
- [ ] **7C.5 [M]** Page abuse limits: rate limit, one active promise per case, no way to change amounts. *Done when:* repeated submissions are refused.
- [ ] **7C.6 [S]** Include the link in message templates. *Done when:* every outgoing reminder carries a working link.
- [ ] **7C.7 [S]** Simulator support: customers may use the page, with their own pay and promise rates. *Done when:* page-driven outcomes appear in batch results.

---

## Phase 8: Extras (cut first if time is short)

- [ ] **8.1 [C]** API: `GET /api/timeline`. *Done when:* returns contacts, scheduled follow-ups, promises and stop markers per case.
- [ ] **8.2 [C]** Bryntum Scheduler: one row per case, past and future events. *Done when:* a seeded run renders readably for 30 cases.
- [ ] **8.3 [C]** Markers for promise dates, stopping rules and recovery. *Done when:* a stopped case shows the rule name on hover.
- [ ] **8.4 [C]** Backup simple timeline inside the audit detail row in case the scheduler trial has limits. *Done when:* the fallback renders without Bryntum.
- [ ] **8.5 [S]** Subscription lane polish: manual-retry trigger after a customer updates payment. *Done when:* the case moves on after a retry event.
- [ ] **8.6 [C]** Balance capture request as a gated, approval-required action. *Done when:* approving it captures the balance in the sandbox.

---

## Phase 9: Evaluation and hardening

- [ ] **9.1 [M]** Run the full experiment: control versus treatment on the seeded batch. *Done when:* the summary shows recovered dollars, uplift and interval.
- [ ] **9.2 [M]** Sensitivity run: repeat with simulator parameters varied across a range and with different seeds. *Done when:* the dashboard shows the range of uplift, not a single number.
- [ ] **9.3 [M]** Show simulator settings and seed beside every result. *Done when:* the summary screen has a settings panel.
- [ ] **9.4 [M]** Zero-violation check: count actions that broke any rule across all runs. *Done when:* the count is zero, or each violation is fixed.
- [ ] **9.5 [M]** Idempotency and race tests: duplicate webhooks, paid event mid-flight, double approval click. *Done when:* each produces exactly one outcome.
- [ ] **9.6 [M]** Webhook endpoint hardening: signature, replay window, rate limit. *Done when:* tests cover all three.
- [ ] **9.7 [M]** Redact personal data in logs; confirm secrets never reach the model or logs. *Done when:* a grep of logs from a full run finds none.
- [ ] **9.8 [S]** Load check: 1,000 cases through the loop. *Done when:* no errors and acceptable run time.
- [ ] **9.9 [M]** Re-verify tool names, event names and plan limits against current PayPal and Render pages. *Done when:* a checklist of items is ticked.

---

## Phase 10: Demo and delivery (to CP7)

- [ ] **10.1 [M]** Pre-seeded demo dataset with a fixed seed. *Done when:* one command resets to the demo state.
- [ ] **10.2 [M]** Demo script with the six beats: at-risk batch, run, approve one case, stopping rule, result against control, audit trail. Add the three standout moments: what-if change, tamper and attack, customer pay page. *Done when:* it runs in about four minutes.
- [ ] **10.3 [M]** Dry-run mode and recorded fallback video in case of network or sandbox trouble. *Done when:* the demo can run fully offline from the seeded data.
- [ ] **10.4 [M]** README: what it is, architecture, how to run locally, how to deploy, how to reproduce results, known limits. *Done when:* a new person can run it from the README alone.
- [ ] **10.5 [M]** Re-read the project documentation. The three standout features, the stack and this build plan are already described there (overview, architecture, workflow, policy, dashboard, evaluation, risks and roadmap sections); add the final measured numbers and correct anything that no longer matches what was built. *Done when:* every claim in the documentation matches the running system.
- [ ] **10.6 [M]** Run the full demo twice in a row without intervention. *Done when:* both runs finish cleanly. **CP7.**

---

## Dependency map (short)

```
0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 9 → 10
          └──────┘         └→ 8 (optional, after 6)

7A needs: 3 (simulator), 4 (loop), 6 (dashboard shell)
7B needs: 1.6 + 4.2 (audit chain), 5.9 (classifier)
7C needs: 2.5 (PayPal wrapper), 4.12 (executor), 6.1 (dashboard shell)
```

## Frameworks and dependencies

Package names are from general knowledge. Confirm each exists, its current version and its licence before installing, and pin exact versions (especially the PayPal toolkit).

### By area

| Area | Package or tool | Used for | First needed |
| --- | --- | --- | --- |
| Language and tooling | `typescript`, `tsx`, `eslint`, `prettier` | Build, run and lint | 1.1 |
| Testing | `vitest`, `fast-check` | Unit tests and property tests (gate rule order, 4.11) | 1.1 |
| HTTP mocking in tests | `msw` or `nock` | Fake PayPal and model responses | 2.1 |
| API server | `fastify`, `@fastify/rate-limit`, `@fastify/cors` | Webhook receiver, dashboard API, abuse limits (7C.5, 9.6) | 1.7 |
| Validation | `zod` | Proposal schema (5.1), request validation | 1.8 |
| Database | `postgres` (Postgres 16 via Docker Compose), `drizzle-orm`, `drizzle-kit`, `pg` | Schema, migrations, queries | 1.3 |
| Logging | `pino` | Structured logs with redaction (9.7) | 1.7 |
| PayPal | `@paypal/agent-toolkit` (includes the MCP server, run with `@paypal/mcp`), plus plain `fetch` for REST calls | Whitelisted tools (2.2) and balance capture (2.9) | 2.2 |
| Model | `@anthropic-ai/sdk` | Decision, drafting and reply classification | 5.3 |
| Dates and time zones | `date-fns`, `date-fns-tz` | Contact hours, due dates (4.9) | 4.4 |
| Seeded randomness | `seedrandom` | Reproducible seeder and simulator (3.2) | 3.2 |
| Hashing and signing | Node built-in `crypto` | Audit hash chain (4.2), signed links (7C.1) | 4.2 |
| Stats | small in-house bootstrap function (no package) | Confidence intervals (7A.6) | 7A.6 |
| Frontend | `react`, `react-dom`, `vite`, `react-router-dom` | Dashboard shell | 6.1 |
| Data fetching | `@tanstack/react-query` | API calls and live refresh | 6.1 |
| Grids | `ag-grid-community`, `ag-grid-react`, and `ag-grid-enterprise` if needed | Cases, approvals, audit (6.5 to 6.8) | 6.5 |
| Scheduler view | `@bryntum/scheduler` and `@bryntum/scheduler-react` (commercial; may need Bryntum's own registry or trial package) | Recovery timeline (8.2) | 8.2 |
| Summary charts | `recharts` or `chart.js` | Summary screen and what-if results | 6.3 |
| Receipt export | `pdfkit`, or plain CSV with no package | Audit receipt (7B.8, optional) | 7B.8 |
| Hosting | Render (Blueprint file `render.yaml`) | API, worker, static site, Postgres | 1.11 |
| Containers | Docker and Docker Compose | Local Postgres | 1.3 |

### By phase (what to install when)

| Phase | Install |
| --- | --- |
| 1 | typescript, tsx, eslint, prettier, vitest, fastify plugins, drizzle-orm, drizzle-kit, pg, pino, zod |
| 2 | @paypal/agent-toolkit, msw or nock |
| 3 | seedrandom |
| 4 | date-fns, date-fns-tz, fast-check |
| 5 | @anthropic-ai/sdk |
| 6 | react, react-dom, vite, react-router-dom, @tanstack/react-query, ag-grid-community, ag-grid-react, recharts or chart.js |
| 7 | no new packages expected (7B.8 may add pdfkit) |
| 8 | @bryntum/scheduler, @bryntum/scheduler-react |

### Accounts and services

PayPal developer account (sandbox), Render, Anthropic API key, a Git host, and AG Grid and Bryntum licence or trial terms (step 0.5).

### Dependency rules

- Keep `packages/policy` and `packages/audit` free of the model SDK and the PayPal toolkit, so the gate and the log can never call either.
- Only `packages/paypal` imports the PayPal toolkit; only `packages/agent` imports the model SDK.
- Add a dependency in the step that first needs it, not earlier.

---

## Risk reminders while building

- Decide retry ownership (PayPal retries, Boomerang contacts) before writing the proposer.
- Sandbox will not fail subscriptions on demand; use the injector from step 3.4.
- Keep the policy gate and audit writer free of any model calls.
- The simulator flatters the agent; never present its uplift as real-world proof.
- Check AG Grid and Bryntum edition limits early (step 0.5).
