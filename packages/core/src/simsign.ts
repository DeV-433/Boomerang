import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signing for simulated webhooks (step 3.4). PayPal will not verify events it did not send, so
 * the failure injector signs its own with SIM_WEBHOOK_SECRET, and the API accepts them only on a
 * separate, sandbox-only route. Header format: "t=<unix seconds>,v1=<hex HMAC-SHA256 of t.body>".
 */
export const SIM_SIGNATURE_HEADER = "boomerang-sim-signature";
export const SIM_SIGNATURE_TOLERANCE_SECONDS = 300;

export function signSimulatedEvent(
  secret: string,
  rawBody: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

export type SimVerifyResult = { ok: true } | { ok: false; reason: string };

export function verifySimulatedEvent(
  secret: string,
  rawBody: string,
  header: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SimVerifyResult {
  if (!header) return { ok: false, reason: "missing signature" };
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return { ok: false, reason: "malformed signature" };
  if (Math.abs(nowSeconds - t) > SIM_SIGNATURE_TOLERANCE_SECONDS)
    return { ok: false, reason: "timestamp outside tolerance" };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}
