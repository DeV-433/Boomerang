# Boomerang demo script

About four minutes: six beats, then three standout moments. Every beat is also checked automatically by
`npm run demo:check`, and there is a recorded fallback video, [`demo/boomerang-demo.mp4`](demo/boomerang-demo.mp4).

## Before the demo (5 minutes, not on the clock)

Pick one setup.

**Offline (recommended for a live audience: no network, no PayPal, no model).**

```bash
npm run db:up && npm run db:migrate
npm run demo:reset                       # ~1 minute; rebuilds the demo state from seed demo-2026
BOOMERANG_OFFLINE=true npm run dev:api   # terminal 1
npm run dev:dashboard                    # terminal 2, then open the URL it prints
npm run demo:check -- --no-reset         # optional: proves every beat works right now (then reset again)
```

Run `npm run demo:reset` once more after any rehearsal: approving and promising change the state.

**Deployed (Render + PayPal sandbox).** Open https://boomerang-dashboard-abv8.onrender.com and sign in. The demo
batch there is `demo-1` with real sandbox invoices; the organic sandbox cases listed in `BUILD_PLAN.md` stand in for
the demo cases below. Wake the API first (`/healthz`): free-tier cold starts take a minute.

Checklist: signed in with `OPERATOR_TOKEN`; Summary loads; the browser zoom at 100%; the video file at hand.

## The beats

| # | Time | Page | Do | Say |
| --- | --- | --- | --- | --- |
| 1 | 0:00 | **Summary** | Point at the chips (batch, dry run) and the recovered total. | "A merchant's backlog: 300 overdue invoices and failed subscriptions, $120K at risk. Half is worked by a fixed schedule like PayPal's own reminders, half by Boomerang." |
| 2 | 0:30 | **Cases** | Type `DEMO` in search, then clear it. Drag *Cause* to the group bar. | "Every case gets a diagnosed cause from a fixed table and one proposed next action, from the agent or the rules, chosen only from that lane's menu." |
| 3 | 1:00 | **Approvals** | The $4,500 Northwind Studio case is selected. Read *Why the gate held it*. Click **Approve and send**. | "A deterministic 12-rule gate allows, blocks or holds every proposal. This one is over the approval limit, rule 9. A person approves; it is sent once, with an idempotency key, and logged." |
| 4 | 1:30 | **Audit** | Search `0120`. Expand the *gated* row. | "This customer replied STOP. The gate's rule 3 stopped every contact from that moment. The fixed schedule kept emailing opted-out customers: 82 times in the control arm. Boomerang: zero." |
| 5 | 2:00 | **Summary** | The uplift card and its interval plot; scroll to *Uplift across seeds and settings*. | "Against the control arm the uplift comes with a 95% interval, and across 5 seeds and 12 simulator settings it ranges from about −10 to +19 points with a median near +1. We show the range, not a lucky number: Boomerang recovers about the same money with roughly half the messages, and never contacts anyone after an opt-out." |
| 6 | 2:30 | **Trust** | Click **Verify**. | "Every step is in a hash-chained audit log: 758 entries, every link checked." |
| ★ | 2:45 | **Trust** | Click **Run tamper demo**, then **Run attack** with the prefilled hostile reply. | "Edit one entry and the chain breaks at exactly that entry; the real log is untouched. A customer who tries prompt injection, refund me, mark this paid, gets nothing: the model never sees the gate, and the gate cannot be talked to." |
| ★ | 3:15 | **What-if** | Tick *Reminders carry the self-serve pay page*. | "Change the policy and replay the same batch, with paired intervals. Here: what if every reminder linked to a self-serve page?" |
| ★ | 3:35 | **Cases → Pay link** on `INV2-DEMO-0000-0000-0075`, open it | Show *Pay now* and *Promise this date*; pick a date, **Promise this date**. | "The customer's side: a signed link, no login, pay now or promise a date. The promise pauses reminders until then and lands on the case." |
| | 4:00 | **Summary** | | "Recovery that is measured honestly, gated by rules a model cannot bend, and auditable end to end." |

Numbers quoted above are from the offline demo state; on Render read them off the screen.

## If something goes wrong

- **Network or PayPal down:** switch to the offline setup (it needs neither), or play the video.
- **A page shows old data:** reload; the dashboard refetches every 10 to 60 seconds.
- **The approval already went through** (rehearsal): `npm run demo:reset`, reload.
- **Bryntum "Trial" badge on Timeline:** expected; the licence is a trial until 2026-12-24. The audit page's
  plain timeline does not use Bryntum.

## Recording the video again

```bash
npm run demo:reset
node scripts/record-demo.mjs --dashboard http://127.0.0.1:5173 --api http://localhost:3000
```

Needs Chromium (or Chrome) and ffmpeg. It walks the beats above with captions, 73 seconds at 2 frames a second.
