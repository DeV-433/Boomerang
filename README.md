# Boomerang

An AI agent that finds PayPal revenue at risk, chooses a recovery action for each case, carries it out within strict policy limits, and reports the money it won back.

> Work in progress. Build progress, the next step and every decision so far are tracked in
> [`BUILD_PLAN.md`](BUILD_PLAN.md): start with its **Current status** section.

## Overview

- **Lanes:** overdue invoices and failed subscription payments
- **Loop:** detect → diagnose → propose → policy gate → execute → observe
- **Safety:** a deterministic policy gate vets every action; the model never calls PayPal directly
- **Proof:** an append-only, hash-chained audit log, plus recovered dollars measured against a control group

## Stack

TypeScript · Node + Fastify · Postgres (Drizzle) · React + Vite · AG Grid · Gemini API · PayPal Sandbox + Agent Toolkit · Render

## Status

Built and demonstrated against the **PayPal sandbox** only.

## Decisions

| Topic | Decision |
| --- | --- |
| Message delivery (plan 0.6) | PayPal's own invoice-reminder tool plus logging. No real email or SMS. |
| Scope (plan 0.7) | Every phase is built, Phases 0 to 10. No cut line. |
| Model | Gemini (`GEMINI_API_KEY`), called only from `packages/agent`. |
| CI (plan 1.2) | GitHub Actions is unavailable on this account, so a `pre-push` hook runs lint, type-check, migrations and all tests, and blocks the push on failure. Render deploys on every push to `main`. |

### Licensing (plan 0.5)

Paid trial licences for both commercial libraries are in hand.

| Feature | Library | Edition needed | Step |
| --- | --- | --- | --- |
| Paging, sorting, filtering, custom cell renderers (row actions, approve buttons) | AG Grid | Community | 6.5, 6.10 |
| Row grouping by cause and state, summed amounts per group | AG Grid | Enterprise | 6.6 |
| Master-detail rows (audit timeline per case) | AG Grid | Enterprise | 6.8 |
| Summary and what-if charts | Recharts | Free (MIT) | 6.3, 7A.8 |
| Recovery timeline, one row per case, events and markers | Bryntum Scheduler (not Scheduler Pro) | Commercial | 8.2, 8.3 |

Without a key, AG Grid Enterprise still runs but shows a watermark and console errors. The fallback timeline (8.4) needs no Bryntum code.

## Setup

```bash
npm install            # also points git at .githooks, enabling the pre-push checks
cp .env.example .env   # then fill in the values
npm run db:up          # local Postgres 17 in Docker
npm run db:migrate
npm run ci             # lint, type-check, migrate, test
npm run dev:api
```

Full instructions coming soon.
