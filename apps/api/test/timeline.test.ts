import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { TimelineResponse } from "@boomerang/core";
import { writeAudit } from "@boomerang/audit";
import {
  actions,
  batches,
  cases,
  customers,
  events,
  jobs,
  simCaseResults,
  simProfiles,
  simRuns,
  type DbHandle,
} from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import { SIM_EPOCH } from "@boomerang/sim";
import { buildApp } from "../src/app";

const TOKEN = "timeline-test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date("2026-11-10T12:00:00Z");
const DAY = 86_400_000;

describe.skipIf(!hasTestDb)("dashboard API: timeline (8.1)", () => {
  let h: DbHandle;
  let app: FastifyInstance;
  let batchId: string;
  let runId: string;
  const ids: Record<string, string> = {};
  const get = async (url: string) => {
    const res = await app.inject({ method: "GET", url, headers: auth });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<TimelineResponse>();
  };

  beforeAll(async () => {
    h = await setupTestDb();
    app = await buildApp({
      db: h,
      verifier: { verify: async () => ({ verified: true }) },
      operatorToken: TOKEN,
      now: () => NOW,
    });
    const [batch] = await h.db
      .insert(batches)
      .values({ name: "timeline", seed: `tl-${randomUUID()}`, size: 3, mode: "offline", simConfig: {} })
      .returning();
    batchId = batch!.id;
    const [cust] = await h.db
      .insert(customers)
      .values({ email: "tl@example.com", simulated: true })
      .returning();
    const mk = async (key: string, values: Partial<typeof cases.$inferInsert>) => {
      const [c] = await h.db
        .insert(cases)
        .values({
          lane: "invoice",
          paypalRef: `TL-${key}-${randomUUID()}`,
          customerId: cust!.id,
          amountCents: 12_500,
          currency: "USD",
          batchId,
          simulated: true,
          openedAt: new Date(NOW.getTime() - 5 * DAY),
          ...values,
        })
        .returning();
      ids[key] = c!.id;
      return c!;
    };
    // An open case: one reminder sent, a promise, a check scheduled for tomorrow.
    const open = await mk("open", { state: "awaiting", promiseDate: "2026-11-14", contacts: 1 });
    await h.db.insert(actions).values({
      caseId: open.id,
      action: "send_reminder",
      proposedBy: "rules",
      status: "executed",
      message: { subject: "Reminder: invoice for $125.00", body: "x" },
      executedAt: new Date(NOW.getTime() - 2 * DAY),
    });
    await h.db
      .insert(jobs)
      .values({
        caseId: open.id,
        kind: "check_case",
        runAt: new Date(NOW.getTime() + DAY),
        reason: "follow up",
      });
    // A case the gate stopped: opted out (rule 3).
    const stopped = await mk("stopped", {
      state: "stopped",
      closedAt: new Date(NOW.getTime() - DAY),
      closeReason: "the customer asked not to be contacted",
    });
    await writeAudit(h.db, {
      caseId: stopped.id,
      actor: "gate",
      kind: "gated",
      data: {
        verdict: "block",
        decidedBy: 3,
        checks: [
          { rule: 1, name: "already_resolved", passed: true },
          { rule: 2, name: "dispute_open", passed: true },
          { rule: 3, name: "opted_out", passed: false },
        ],
      },
    });
    // A recovered case with its PayPal event.
    const paid = await mk("paid", {
      state: "recovered",
      closedAt: new Date(NOW.getTime() - 3 * DAY),
      closeReason: "PayPal reports PAID",
      recoveredCents: 12_500,
    });
    await h.db.insert(events).values({
      paypalEventId: `WH-TL-${randomUUID()}`,
      type: "INVOICING.INVOICE.PAID",
      resourceId: paid.paypalRef,
      payload: {},
      rawBody: "{}",
      headers: {},
      caseId: paid.id,
      receivedAt: new Date(NOW.getTime() - 3 * DAY),
    });

    // A finished simulator run over two of the cases.
    const [run] = await h.db
      .insert(simRuns)
      .values({
        batchId,
        arm: "treatment",
        strategy: "boomerang-rules",
        seed: "tl",
        simConfig: { horizonDays: 30 },
        finishedAt: new Date(NOW.getTime() + 60_000),
        startedAt: new Date(NOW.getTime() + 60_000),
      })
      .returning();
    runId = run!.id;
    await h.db.insert(simProfiles).values([
      { caseId: open.id, batchId, batchIndex: 0, customerType: "forgetful", hidden: {} },
      { caseId: stopped.id, batchId, batchIndex: 1, customerType: "avoider", hidden: {} },
    ]);
    await h.db.insert(simCaseResults).values([
      {
        runId,
        caseId: open.id,
        outcome: "recovered",
        amountCents: 12_500,
        recoveredCents: 12_500,
        recoveredDay: 4,
        contacts: 1,
        contactsAfterOptOut: 0,
        timeline: [
          { day: 0, event: "contact", kind: "targeted_reminder", outcome: "promise", afterOptOut: false },
          { day: 3, event: "promise_due", kept: true },
          { day: 4, event: "paid", via: "promise" },
        ],
      },
      {
        runId,
        caseId: stopped.id,
        outcome: "opted_out",
        amountCents: 12_500,
        recoveredCents: 0,
        recoveredDay: null,
        contacts: 1,
        contactsAfterOptOut: 0,
        timeline: [
          { day: 2, event: "contact", kind: "targeted_reminder", outcome: "opt_out", afterOptOut: false },
        ],
      },
    ]);
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("returns contacts, scheduled follow-ups, promises and stop markers per live case", async () => {
    const t = await get(`/api/timeline?batch=${batchId}`);
    expect(t.source).toBe("live");
    expect(t.total).toBe(3);
    expect(t.rows.map((r) => r.caseId).sort()).toEqual(Object.values(ids).sort());
    const of = (key: string) => t.events.filter((e) => e.caseId === ids[key]);

    const open = of("open");
    expect(open.map((e) => e.kind).sort()).toEqual(["contact", "followup", "opened", "promise"]);
    expect(open.find((e) => e.kind === "contact")).toMatchObject({
      label: "send reminder",
      detail: "Reminder: invoice for $125.00",
      future: false,
    });
    expect(open.find((e) => e.kind === "followup")).toMatchObject({ future: true, detail: "follow up" });
    expect(open.find((e) => e.kind === "promise")).toMatchObject({
      start: "2026-11-14T00:00:00.000Z",
      end: "2026-11-15T00:00:00.000Z",
      future: true,
    });

    const stop = of("stopped").find((e) => e.kind === "stopped");
    expect(stop).toMatchObject({
      rule: { number: 3, name: "opted_out" },
      detail: "the customer asked not to be contacted",
    });
    const paid = of("paid");
    expect(paid.find((e) => e.kind === "recovered")).toMatchObject({ rule: null, label: "Recovered" });
    expect(paid.find((e) => e.kind === "paypal")).toMatchObject({ label: "INVOICING.INVOICE.PAID" });

    // Every event lies inside the returned range.
    for (const e of t.events) {
      expect(e.start >= t.range.start && e.start <= t.range.end).toBe(true);
    }
  });

  it("returns a stored simulator run on the simulator's clock, with the gate rule on stops", async () => {
    const t = await get(`/api/timeline?source=run&run=${runId}`);
    expect(t.source).toBe("run");
    expect(t.run).toMatchObject({ id: runId, cases: 2, strategy: "boomerang-rules" });
    expect(t.runs.some((r) => r.id === runId)).toBe(true);
    expect(t.rows.map((r) => r.caseId)).toEqual([ids.open, ids.stopped]);
    const day = (d: number) => new Date(SIM_EPOCH.getTime() + d * DAY).toISOString();
    const recovered = t.events.filter((e) => e.caseId === ids.open);
    expect(recovered.map((e) => [e.kind, e.start])).toEqual([
      ["opened", day(0)],
      ["contact", day(0)],
      ["promise", day(3)],
      ["recovered", day(4)],
    ]);
    const stop = t.events.find((e) => e.caseId === ids.stopped && e.kind === "stopped");
    expect(stop).toMatchObject({ start: day(2), rule: { number: 3, name: "opted_out" } });
    expect(t.range).toEqual({ start: day(-1), end: day(31) });
  });

  it("returns just one case for the audit screen's small timeline (8.4)", async () => {
    const t = await get(`/api/timeline?case=${ids.stopped}`);
    expect(t.rows.map((r) => r.caseId)).toEqual([ids.stopped]);
    expect(new Set(t.events.map((e) => e.caseId))).toEqual(new Set([ids.stopped]));
    expect(t.events.find((e) => e.kind === "stopped")?.rule).toEqual({ number: 3, name: "opted_out" });
  });

  it("pages, validates and requires the token", async () => {
    const first = await get(`/api/timeline?batch=${batchId}&limit=2`);
    const second = await get(`/api/timeline?batch=${batchId}&limit=2&offset=2`);
    expect(new Set([...first.rows, ...second.rows].map((r) => r.caseId)).size).toBe(3);
    const bad = await app.inject({ method: "GET", url: "/api/timeline?limit=0", headers: auth });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "GET",
      url: `/api/timeline?source=run&run=${randomUUID()}`,
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/timeline" })).statusCode).toBe(401);
  });
});
