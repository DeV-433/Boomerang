import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SIM_SIGNATURE_HEADER, verifySimulatedEvent } from "@boomerang/core";
import { events } from "@boomerang/db";
import type { AppDeps } from "../app";

/** Headers worth keeping with a stored event: PayPal's transmission headers plus basic metadata. */
function storedHeaders(req: FastifyRequest): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (
      name.startsWith("paypal-") ||
      name === "content-type" ||
      name === "user-agent" ||
      name === "boomerang-sim-signature"
    ) {
      kept[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return kept;
}

interface PayPalEventEnvelope {
  id?: unknown;
  event_type?: unknown;
  resource_type?: unknown;
  resource?: { id?: unknown; invoice?: { id?: unknown } };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Subscription and payment events carry the id at resource.id; invoicing events nest it under resource.invoice. */
export function resourceIdOf(envelope: PayPalEventEnvelope): string | null {
  return str(envelope.resource?.id) ?? str(envelope.resource?.invoice?.id);
}

/** 9.6: how old a PayPal transmission may be, and how far ahead of our clock (skew). */
export const REPLAY_WINDOW_MS = 15 * 60_000;
export const FUTURE_SKEW_MS = 5 * 60_000;
/** 9.6: deliveries per client address per minute on each webhook route. Generous: seeding a batch makes PayPal send bursts, and a 429 only delays them (PayPal redelivers for three days). */
export const WEBHOOK_RATE_LIMIT_PER_MINUTE = 600;
/** PayPal events are a few kilobytes; anything far larger is not one. */
export const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;

/**
 * 9.6: rejects a replayed delivery. PayPal signs the transmission time together with the body
 * (transmission_id|transmission_time|webhook_id|crc32), so it cannot be changed without failing
 * verification; each redelivery is a new transmission with a new time. Checked before the
 * verification call, so a flood of stale replays never reaches PayPal.
 */
export function checkTransmissionTime(
  header: string | string[] | undefined,
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return { ok: false, reason: "missing paypal-transmission-time" };
  const sent = Date.parse(value);
  if (Number.isNaN(sent)) return { ok: false, reason: "unreadable paypal-transmission-time" };
  const age = now.getTime() - sent;
  if (age > REPLAY_WINDOW_MS)
    return { ok: false, reason: `transmission is ${Math.round(age / 60_000)} minutes old` };
  if (age < -FUTURE_SKEW_MS) return { ok: false, reason: "transmission time is in the future" };
  return { ok: true };
}

/**
 * POST /webhooks/paypal
 *
 * Verifies the signature, stores the raw event once, and returns 200 quickly. No case logic runs
 * here: the worker processes stored events later, so PayPal never waits on Boomerang's decisions.
 */
export async function webhookRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // Keep the body as the exact string PayPal sent; signature verification depends on the raw bytes.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
    (_req, body, done) => done(null, body),
  );
  // 9.6: per-address rate limit (Render's proxy sets the client address; trustProxy is on).
  await app.register(rateLimit, { global: false });
  const limited = {
    config: {
      rateLimit: {
        max: deps.webhookRateLimitPerMinute ?? WEBHOOK_RATE_LIMIT_PER_MINUTE,
        timeWindow: "1 minute",
      },
    },
  };

  app.post("/webhooks/paypal", limited, async (req, reply) => {
    const rawBody = typeof req.body === "string" ? req.body : "";
    let envelope: PayPalEventEnvelope;
    try {
      envelope = JSON.parse(rawBody) as PayPalEventEnvelope;
    } catch {
      return reply.code(400).send({ error: "invalid_json" });
    }
    const eventId = str(envelope?.id);
    const eventType = str(envelope?.event_type);
    if (!eventId || !eventType) return reply.code(400).send({ error: "missing_event_id_or_type" });

    const fresh = checkTransmissionTime(
      req.headers["paypal-transmission-time"],
      (deps.now ?? (() => new Date()))(),
    );
    if (!fresh.ok) {
      req.log.warn(
        { eventId, eventType, reason: fresh.reason },
        "webhook rejected: outside the replay window",
      );
      return reply.code(400).send({ error: "stale_or_missing_transmission_time" });
    }

    let result;
    try {
      result = await deps.verifier.verify(req.headers, rawBody);
    } catch (err) {
      // PayPal could not be asked. Answer 503 so PayPal redelivers instead of the event being lost.
      req.log.error({ err, eventId }, "webhook verification call failed");
      return reply.code(503).send({ error: "verification_unavailable" });
    }
    if (!result.verified) {
      req.log.warn({ eventId, eventType, reason: result.reason }, "webhook rejected: signature not verified");
      return reply.code(400).send({ error: "invalid_signature" });
    }

    const inserted = await deps.db.db
      .insert(events)
      .values({
        paypalEventId: eventId,
        type: eventType,
        resourceType: str(envelope.resource_type),
        resourceId: resourceIdOf(envelope),
        payload: envelope,
        rawBody,
        headers: storedHeaders(req),
        source: "webhook",
      })
      .onConflictDoNothing({ target: events.paypalEventId })
      .returning({ id: events.id });

    const duplicate = inserted.length === 0;
    req.log.info({ eventId, eventType, duplicate }, "webhook stored");
    return reply.code(200).send({ received: true, duplicate });
  });

  // Step 3.4: injected failure events for subscriptions the sandbox will not fail on its own.
  // Exists only in the sandbox with SIM_WEBHOOK_SECRET set; signed with our own HMAC, stored as simulated.
  if (deps.simulation) {
    const { secret } = deps.simulation;
    app.post("/webhooks/simulated", limited, async (req, reply) => {
      const rawBody = typeof req.body === "string" ? req.body : "";
      const header = req.headers[SIM_SIGNATURE_HEADER];
      const check = verifySimulatedEvent(secret, rawBody, Array.isArray(header) ? header[0] : header);
      if (!check.ok) {
        req.log.warn({ reason: check.reason }, "simulated event rejected");
        return reply.code(400).send({ error: "invalid_signature" });
      }
      let envelope: PayPalEventEnvelope;
      try {
        envelope = JSON.parse(rawBody) as PayPalEventEnvelope;
      } catch {
        return reply.code(400).send({ error: "invalid_json" });
      }
      const eventId = str(envelope?.id);
      const eventType = str(envelope?.event_type);
      if (!eventId?.startsWith("WH-SIM-") || !eventType)
        return reply.code(400).send({ error: "simulated ids must start with WH-SIM-" });

      const inserted = await deps.db.db
        .insert(events)
        .values({
          paypalEventId: eventId,
          type: eventType,
          resourceType: str(envelope.resource_type),
          resourceId: resourceIdOf(envelope),
          payload: envelope,
          rawBody,
          headers: storedHeaders(req),
          source: "simulated",
          simulated: true,
        })
        .onConflictDoNothing({ target: events.paypalEventId })
        .returning({ id: events.id });
      const duplicate = inserted.length === 0;
      req.log.info({ eventId, eventType, duplicate }, "simulated event stored");
      return reply.code(200).send({ received: true, duplicate, simulated: true });
    });
  }
}
