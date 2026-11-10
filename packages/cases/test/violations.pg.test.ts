import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actions, approvals, cases, customers, events, type DbHandle } from "@boomerang/db";
import { hasTestDb, setupTestDb } from "@boomerang/db/testing";
import { DEFAULT_POLICY } from "@boomerang/policy";
import { liveViolations } from "../src/violations";

const H = 3_600_000;
// Tuesday 2026-11-10, 15:00 UTC = 10:00 in New York.
const T0 = new Date("2026-11-10T15:00:00Z");
const at = (hours: number) => new Date(T0.getTime() + hours * H);

describe.skipIf(!hasTestDb)("zero-violation check on executed actions (9.4)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await setupTestDb();
  });
  afterAll(async () => {
    await h?.close();
  });

  async function newCase(opts: { optedOutAt?: Date; closedAt?: Date } = {}) {
    const [c] = await h.db
      .insert(customers)
      .values({
        email: `v-${randomUUID()}@example.com`,
        timezone: "America/New_York",
        optedOutAt: opts.optedOutAt,
        optedOut: Boolean(opts.optedOutAt),
      })
      .returning();
    const [k] = await h.db
      .insert(cases)
      .values({
        lane: "invoice",
        paypalRef: `INV2-V-${randomUUID()}`,
        customerId: c!.id,
        amountCents: 5_000,
        currency: "USD",
        state: opts.closedAt ? "recovered" : "awaiting",
        closedAt: opts.closedAt,
      })
      .returning();
    return k!.id;
  }
  async function executed(
    caseId: string,
    when: Date,
    action = "send_reminder",
    verdict: "allow" | "hold" = "allow",
  ) {
    const [a] = await h.db
      .insert(actions)
      .values({
        caseId,
        action,
        proposedBy: "rules",
        status: "executed",
        gateVerdict: verdict,
        executedAt: when,
      })
      .returning();
    return a!.id;
  }
  const mine = async (caseId: string) =>
    (await liveViolations(h.db, DEFAULT_POLICY)).violations
      .filter((v) => v.caseId === caseId)
      .map((v) => v.rule);

  it("passes contacts that keep every rule", async () => {
    const id = await newCase();
    await executed(id, at(0));
    await executed(id, at(48));
    await executed(id, at(96)); // Saturday 10:00 New York (Sunday is not a contact day)
    expect(await mine(id)).toEqual([]);
  });

  it("flags spacing, the per-case cap and contact hours", async () => {
    const spacing = await newCase();
    await executed(spacing, at(0));
    await executed(spacing, at(5));
    expect(await mine(spacing)).toEqual([7]);

    const cap = await newCase();
    for (const d of [0, 2, 4, 6]) await executed(cap, at(d * 24 + (d === 4 ? 48 : 0)));
    expect((await mine(cap)).filter((r) => r === 6).length).toBeGreaterThan(0);

    const night = await newCase();
    await executed(night, at(13)); // 04:00 in New York
    expect(await mine(night)).toEqual([8]);
  });

  it("flags contact after opt-out, after closing and after a dispute", async () => {
    const optedOut = await newCase({ optedOutAt: at(-1) });
    await executed(optedOut, at(0));
    expect(await mine(optedOut)).toEqual([3]);

    const closed = await newCase({ closedAt: at(-1) });
    await executed(closed, at(0));
    expect(await mine(closed)).toEqual([1]);

    const disputed = await newCase();
    await h.db.insert(events).values({
      paypalEventId: `WH-V-${randomUUID()}`,
      type: "CUSTOMER.DISPUTE.CREATED",
      payload: {},
      rawBody: "{}",
      headers: {},
      caseId: disputed,
      receivedAt: at(-2),
    });
    await executed(disputed, at(0));
    expect(await mine(disputed)).toEqual([2]);
  });

  it("flags money moved without approval, or anything run that the gate did not allow", async () => {
    const capture = await newCase();
    await executed(capture, at(0), "request_balance_capture", "allow");
    expect(await mine(capture)).toEqual([12]);

    const approved = await newCase();
    const a = await executed(approved, at(1), "request_balance_capture", "hold");
    await h.db
      .insert(approvals)
      .values({ actionId: a, status: "approved", decidedBy: "op", decidedAt: at(0) });
    expect(await mine(approved)).toEqual([]);

    const held = await newCase();
    await executed(held, at(0), "send_reminder", "hold");
    expect(await mine(held)).toEqual([0]);
  });
});
