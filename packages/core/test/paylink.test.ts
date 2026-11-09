import { describe, expect, it } from "vitest";
import { payLinkExpiry, signPayLink, verifyPayLink } from "../src/paylink";

const SECRET = "test-secret-of-sufficient-length";
const NOW = new Date("2026-11-10T12:00:00Z");
const CASE = "f1360124-87f3-4482-9983-59b0f2877c00";

describe("signed pay links (7C.1)", () => {
  it("accepts a fresh token and returns its case", () => {
    const t = signPayLink(SECRET, CASE, new Date("2026-12-01T00:00:00Z"));
    expect(verifyPayLink(SECRET, t, NOW)).toEqual({
      ok: true,
      caseId: CASE,
      expiresAt: new Date("2026-12-01T00:00:00Z"),
    });
  });

  it("rejects a tampered payload, a tampered signature, another secret and garbage", () => {
    const t = signPayLink(SECRET, CASE, new Date("2026-12-01T00:00:00Z"));
    const [payload, sig] = t.split(".") as [string, string];
    const otherCase = Buffer.from(
      JSON.stringify({ c: "00000000-0000-4000-8000-000000000000", e: 1_900_000_000, v: 1 }),
    ).toString("base64url");
    expect(verifyPayLink(SECRET, `${otherCase}.${sig}`, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    expect(verifyPayLink(SECRET, `${payload}.${flipped}`, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(verifyPayLink("another-secret-that-is-long-enough", t, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    for (const bad of ["", "abc", "a.b.c", `${payload}.`, "<script>.x", "x".repeat(600)])
      expect(verifyPayLink(SECRET, bad, NOW).ok).toBe(false);
  });

  it("rejects an expired token", () => {
    const t = signPayLink(SECRET, CASE, new Date("2026-11-10T11:59:59Z"));
    expect(verifyPayLink(SECRET, t, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("gives the same link for the same case, so a held message's link stays valid", () => {
    const opened = new Date("2026-11-09T12:00:00Z");
    expect(signPayLink(SECRET, CASE, payLinkExpiry(opened))).toBe(
      signPayLink(SECRET, CASE, payLinkExpiry(opened)),
    );
    expect(() => signPayLink("short", CASE, payLinkExpiry(opened))).toThrow(/16 characters/);
  });
});
