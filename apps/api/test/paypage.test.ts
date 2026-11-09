import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  configurePayLinks,
  loadSnapshot,
  messageFacts,
  paymentLink,
  processPendingEvents,
  renderMessage,
} from "@boomerang/cases";
import { lintMessage, payLinkExpiry, signPayLink, verifyPayLink } from "@boomerang/core";
import { cases, customers, events, jobs, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import { buildApp } from "../src/app";

const SECRET = "paypage-test-secret-0123456789";
const NOW = new Date("2026-11-10T15:00:00Z");

describe.skipIf(!hasTestDb)("self-serve pay-or-promise page (7C.1 to 7C.6)", () => {
  let h: DbHandle;
  let app: FastifyInstance;
  let off: FastifyInstance;

  async function openCase(
    o: { state?: "awaiting" | "recovered" | "stopped"; promiseDate?: string | null } = {},
  ) {
    const [cust] = await h.db
      .insert(customers)
      .values({ email: `secret-${randomUUID()}@example.com`, name: "Private Person", simulated: true })
      .returning();
    const r = randomUUID().replace(/-/g, "").toUpperCase();
    const ref = `INV2-${r.slice(0, 4)}-${r.slice(4, 8)}-${r.slice(8, 12)}-${r.slice(12, 16)}`;
    const [c] = await h.db
      .insert(cases)
      .values({
        lane: "invoice",
        paypalRef: ref,
        customerId: cust!.id,
        amountCents: 12_345,
        currency: "USD",
        state: o.state ?? "awaiting",
        dueDate: "2026-11-01",
        promiseDate: o.promiseDate ?? null,
        simulated: true,
        openedAt: NOW,
        closedAt: o.state && o.state !== "awaiting" ? NOW : null,
      })
      .returning();
    return { c: c!, cust: cust!, token: signPayLink(SECRET, c!.id, payLinkExpiry(NOW)) };
  }
  const promise = (token: string, body: string, ip = "10.0.0.1") =>
    app.inject({
      method: "POST",
      url: `/pay/${token}/promise`,
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
      payload: body,
    });

  beforeAll(async () => {
    h = await setupTestDb();
    const verifier = { verify: async () => ({ verified: false as const, reason: "unused" }) };
    app = await buildApp({
      db: h,
      verifier,
      payLinkSecret: SECRET,
      merchantName: "Acme Tools",
      now: () => NOW,
    });
    off = await buildApp({ db: h, verifier });
  });
  afterEach(() => configurePayLinks(null));
  afterAll(async () => {
    await app?.close();
    await off?.close();
    await h?.close();
  });

  it("shows amount, reference and merchant name, and nothing else about the customer (7C.2)", async () => {
    const { c, cust, token } = await openCase();
    const res = await app.inject({ method: "GET", url: `/pay/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("$123.45");
    expect(res.body).toContain(c.paypalRef);
    expect(res.body).toContain("Acme Tools");
    expect(res.body).toContain(`https://www.sandbox.paypal.com/invoice/p/#${c.paypalRef}`);
    expect(res.body).not.toContain(cust.email!);
    expect(res.body).not.toContain("Private Person");
    expect(res.headers).toMatchObject({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    });
    expect(String(res.headers["content-security-policy"])).toContain("default-src 'none'");
  });

  it("opens with a valid token only (7C.1, 7C.2)", async () => {
    const { c, token } = await openCase();
    const [payload, sig] = token.split(".") as [string, string];
    expect(
      (await app.inject({ method: "GET", url: `/pay/${payload}.${sig.slice(0, -2)}xx` })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: "GET", url: "/pay/not-a-token" })).statusCode).toBe(404);
    const expired = signPayLink(SECRET, c.id, new Date(NOW.getTime() - 1000));
    expect((await app.inject({ method: "GET", url: `/pay/${expired}` })).statusCode).toBe(410);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/pay/${signPayLink(SECRET, randomUUID(), payLinkExpiry(NOW))}`,
        })
      ).statusCode,
    ).toBe(404);
    expect((await off.inject({ method: "GET", url: `/pay/${token}` })).statusCode).toBe(503);
  });

  it("a promise writes a promise event; processing it sets the promise and the next check (7C.4)", async () => {
    const { c, token } = await openCase();
    const res = await promise(token, "date=2026-11-17");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain("Tuesday, November 17, 2026");
    const [ev] = await h.db
      .select()
      .from(events)
      .where(and(eq(events.resourceId, c.paypalRef), eq(events.source, "paypage")));
    expect(ev!.payload).toMatchObject({
      resource: { classification: "promise", promise_date: "2026-11-17", lane: "invoice" },
    });

    await processPendingEvents(h.db, { now: () => NOW });
    const [after] = await h.db.select().from(cases).where(eq(cases.id, c.id));
    expect(after!.promiseDate).toBe("2026-11-17");
    expect(
      await h.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.caseId, c.id), eq(jobs.status, "pending"))),
    ).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/pay/${token}` })).body).toContain(
      "You told us you will pay by",
    );
  });

  it("refuses a second promise, a date out of range, and any amount (7C.5)", async () => {
    const { token } = await openCase();
    expect((await promise(token, "date=2026-11-12", "10.0.0.2")).statusCode).toBe(200);
    expect((await promise(token, "date=2026-11-13", "10.0.0.2")).statusCode).toBe(409); // one active promise per case
    const fresh = (await openCase()).token;
    expect((await promise(fresh, "date=2026-11-09", "10.0.0.3")).statusCode).toBe(400); // in the past
    expect((await promise(fresh, "date=2026-12-30", "10.0.0.3")).statusCode).toBe(400); // beyond 14 days
    expect((await promise(fresh, "date=nope", "10.0.0.3")).statusCode).toBe(400);
    const withAmount = await promise(fresh, "date=2026-11-12&amount=1", "10.0.0.3");
    expect(withAmount.statusCode).toBe(400);
    expect(withAmount.body).toContain("Only a date");
    const paid = await openCase({ state: "recovered" });
    expect((await app.inject({ method: "GET", url: `/pay/${paid.token}` })).body).toContain(
      "Paid. Thank you!",
    );
    expect((await promise(paid.token, "date=2026-11-12", "10.0.0.4")).statusCode).toBe(409);
  });

  it("rate-limits repeated submissions from one address (7C.5)", async () => {
    const { token } = await openCase();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await promise(token, "date=bad", "10.9.9.9")).statusCode);
    expect(codes.slice(0, 5).every((s) => s === 400)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it("messages carry a working pay-page link when configured, and still pass the lint (7C.6)", async () => {
    const { c } = await openCase();
    configurePayLinks({ secret: SECRET, baseUrl: "https://api.example.com/" });
    const s = (await loadSnapshot(h.db, c.id, NOW))!;
    const link = paymentLink(s);
    expect(link).toMatch(/^https:\/\/api\.example\.com\/pay\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyPayLink(SECRET, link.split("/pay/")[1]!, NOW)).toMatchObject({ ok: true, caseId: c.id });
    const msg = renderMessage("reminder", s, "friendly");
    expect(msg.body).toContain(link);
    expect(lintMessage(msg.body, messageFacts(s))).toEqual({ ok: true, issues: [] });
    expect((await app.inject({ method: "GET", url: `/pay/${link.split("/pay/")[1]}` })).statusCode).toBe(200);
  });
});
