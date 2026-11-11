import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Logger } from "@boomerang/core";
import { events, type Database } from "@boomerang/db";
import { classifyReply } from "./agent";
import { ModelCallError, type ModelClient } from "./model";

export const REPLY_EVENT = "BOOMERANG.CUSTOMER.REPLY";

interface ReplyResource {
  paypal_ref?: string;
  lane?: string;
  text?: string;
  classification?: string | null;
  promise_date?: string | null;
}

/**
 * Step 5.9 in the loop: labels stored customer replies that arrived as raw text, before the case
 * opener sees them. The text goes only to the no-tools classifier; the case opener and the decision
 * call only ever see the label. The raw text stays on the stored event, for people to read in the
 * dashboard, clearly marked as customer-written.
 */
export async function classifyPendingReplies(
  db: Database,
  client: ModelClient,
  options: { now?: () => Date; limit?: number; logger?: Logger } = {},
): Promise<number> {
  const pending = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.type, REPLY_EVENT),
        isNull(events.processedAt),
        sql`${events.payload}->'resource'->>'text' is not null`,
        sql`${events.payload}->'resource'->>'classification' is null`,
      ),
    )
    .orderBy(asc(events.receivedAt))
    .limit(options.limit ?? 20);

  let done = 0;
  for (const event of pending) {
    const payload = event.payload as { resource?: ReplyResource };
    const resource = payload.resource ?? {};
    const now = options.now?.() ?? new Date();
    let c: Awaited<ReturnType<typeof classifyReply>>;
    try {
      c = await classifyReply(client, resource.text ?? "", now, { caseId: event.caseId });
    } catch (error) {
      // B4: the model is unreachable or out of quota. The reply stays unlabelled for the next tick;
      // nothing else in the worker waits on it.
      if (!(error instanceof ModelCallError)) throw error;
      options.logger?.warn(
        { eventId: event.paypalEventId, err: error.message },
        "reply classification unavailable; will retry",
      );
      break;
    }
    const updated = {
      ...payload,
      resource: { ...resource, classification: c.label, promise_date: c.promiseDate },
      classifier: { model: c.model, promptVersion: c.promptVersion, at: now.toISOString() },
    };
    await db.update(events).set({ payload: updated }).where(eq(events.id, event.id));
    options.logger?.info({ eventId: event.paypalEventId, label: c.label }, "reply classified");
    done++;
  }
  return done;
}
