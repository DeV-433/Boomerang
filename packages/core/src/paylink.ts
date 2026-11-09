import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Step 7C.1: signed pay-page links. A token is `<payload>.<signature>`, both base64url:
 * the payload is {c: case id, e: expiry in epoch seconds, v: 1}; the signature is HMAC-SHA256 of
 * the payload with PAY_LINK_SECRET. Anything edited, expired or signed with another secret is refused.
 * The token carries no personal data: only the case id and the expiry.
 */
const VERSION = 1;

const b64url = (b: Buffer) => b.toString("base64url");

function sign(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(`boomerang-pay|${payload}`).digest();
}

export function signPayLink(secret: string, caseId: string, expiresAt: Date): string {
  if (!secret || secret.length < 16) throw new Error("PAY_LINK_SECRET must be at least 16 characters");
  const payload = b64url(
    Buffer.from(JSON.stringify({ c: caseId, e: Math.floor(expiresAt.getTime() / 1000), v: VERSION })),
  );
  return `${payload}.${b64url(sign(secret, payload))}`;
}

export type PayLinkVerdict =
  | { ok: true; caseId: string; expiresAt: Date }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyPayLink(secret: string, token: string, now: Date = new Date()): PayLinkVerdict {
  if (typeof token !== "string" || token.length > 512) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[0] + parts[1]))
    return { ok: false, reason: "malformed" };
  const [payload, signature] = parts as [string, string];
  const expected = sign(secret, payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: "bad_signature" };
  let body: { c?: unknown; e?: unknown; v?: unknown };
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof body;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (body.v !== VERSION || typeof body.c !== "string" || typeof body.e !== "number")
    return { ok: false, reason: "malformed" };
  const expiresAt = new Date(body.e * 1000);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, caseId: body.c, expiresAt };
}

/** Links stay valid long after any case could still be open, and the same case always gets the same link. */
export const PAY_LINK_LIFETIME_DAYS = 120;
export const payLinkExpiry = (openedAt: Date) =>
  new Date(openedAt.getTime() + PAY_LINK_LIFETIME_DAYS * 86_400_000);

/** The latest date the pay page lets a customer promise, in days from today (7C.4). */
export const PAY_PAGE_PROMISE_MAX_DAYS = 14;
