import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { SystemStatus } from "@boomerang/core";
import { processPendingEvents, reportWorkerMode, runCaseCheck } from "@boomerang/cases";
import { auditLog, jobs, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import type { WebhookVerifier } from "@boomerang/paypal";
import { buildApp } from "../src/app";
import {
  caseByRef,
  fakePayPal,
  hoursLater,
  invoiceId,
  overdueInvoice,
  setCustomerTimezone,
  storeEvent,
  tool,
  TUESDAY_10AM_NY,
} from "../../../packages/cases/test/helpers";

const verifier: WebhookVerifier = { verify: async () => ({ verified: true }) };
const TOKEN = "system-test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

describe.skipIf(!hasTestDb)("dashboard API: global pause (6.11)", () => {
  let h: DbHandle;
  let app: FastifyInstance;
  const setPaused = (paused: boolean) =>
    app.inject({ method: "POST", url: "/api/system/pause", headers: auth, payload: { paused } });

  beforeAll(async () => {
    h = await setupTestDb();
    // B15: the API sends live only when the worker reports live as well.
    await reportWorkerMode(h.db, "live");
    app = await buildApp({ db: h, verifier, operatorToken: TOKEN, policyMode: "live" });
  });
  afterAll(async () => {
    await setPaused(false);
    await app?.close();
    await h?.close();
  });

  it("pausing stops every new action within one worker cycle; resuming lets the next cycle send", async () => {
    const fake = fakePayPal();
    const id = invoiceId();
    await storeEvent(h.db, "BOOMERANG.INVOICE.OVERDUE", { invoice: overdueInvoice(id) }, { source: "poll" });
    await processPendingEvents(h.db, { now: () => TUESDAY_10AM_NY });
    const c = await caseByRef(h.db, id);
    await setCustomerTimezone(h.db, c.customerId, "America/New_York");

    try {
      const paused = await setPaused(true);
      expect(paused.statusCode).toBe(200);
      expect(paused.json<SystemStatus>()).toMatchObject({
        paused: true,
        pausedBy: "operator",
        mode: "live",
        apiMode: "live",
        workerMode: "live",
      });
      const [entry] = await h.db
        .select()
        .from(auditLog)
        .where(and(isNull(auditLog.caseId), eq(auditLog.kind, "system")))
        .orderBy(desc(auditLog.id))
        .limit(1);
      expect(entry).toMatchObject({ actor: "operator", data: { paused: true } });

      // The check a worker cycle runs for this case, while paused: nothing reaches PayPal.
      // (runCaseCheck directly: the shared test database holds other tests' due jobs too.)
      const deps = { db: h.db, gateway: fake.gateway, mode: "live" as const };
      const first = await runCaseCheck({ ...deps, now: () => TUESDAY_10AM_NY }, c.id);
      expect(first).toMatchObject({ outcome: "deferred" });
      expect(tool(fake, "send_invoice_reminder")).toHaveLength(0);
      const [retry] = await h.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.caseId, c.id), eq(jobs.status, "pending")));
      expect(retry).toBeDefined();

      // Resume: the next cycle after the retry time sends the reminder.
      expect((await setPaused(false)).json<SystemStatus>().paused).toBe(false);
      const later = hoursLater(TUESDAY_10AM_NY, 0.5);
      const second = await runCaseCheck({ ...deps, now: () => later }, c.id);
      expect(second).toMatchObject({ outcome: "executed" });
      expect(tool(fake, "send_invoice_reminder")).toHaveLength(1);
    } finally {
      await setPaused(false);
    }
  });

  it("reports the state and validates the body", async () => {
    const s = await app.inject({ method: "GET", url: "/api/system", headers: auth });
    expect(s.json<SystemStatus>()).toMatchObject({ paused: false });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/system/pause",
          headers: auth,
          payload: { paused: "yes" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/api/system/pause", payload: { paused: true } })).statusCode,
    ).toBe(401);
  });
});
