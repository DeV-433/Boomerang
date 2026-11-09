import rateLimit from "@fastify/rate-limit";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { formatMoney, isEndState, PAY_PAGE_PROMISE_MAX_DAYS, verifyPayLink } from "@boomerang/core";
import { paypalPayLink } from "@boomerang/cases";
import { cases, events } from "@boomerang/db";
import type { AppDeps } from "../app";

/** The event a pay-page promise becomes: the same as a classified customer reply, minus any text. */
export const PAY_PAGE_SOURCE = "paypage";
const REPLY_EVENT = "BOOMERANG.CUSTOMER.REPLY";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const longDate = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

function page(reply: FastifyReply, status: number, title: string, body: string) {
  return (
    reply
      .code(status)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      // The token is in the URL: never leak it in a Referer header, never let the page be framed.
      .header("referrer-policy", "no-referrer")
      .header("x-frame-options", "DENY")
      .header("x-content-type-options", "nosniff")
      .header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      )
      .header("x-robots-tag", "noindex").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--text:#1c1c1a;--muted:#6b6b66;--border:#e3e3de;--accent:#2f5bd3;--ok:#1f8a4c;--bad:#c2362b;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1d1d1b;--text:#ececea;--muted:#9a9a94;--border:#33332f;--accent:#7c9cf0;--ok:#4cc283;--bad:#f0786e;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:460px;margin:0 auto;padding:32px 16px}.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 4px}.muted{color:var(--muted)}.amount{font-size:34px;font-weight:700;margin:8px 0}
.button{display:block;width:100%;text-align:center;padding:12px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.secondary{background:transparent;color:var(--accent)}label{display:block;font-size:14px;margin:12px 0 4px}input[type=date]{width:100%;padding:10px;font:inherit;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--text)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.small{font-size:13px}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:12px 0 0}dt{color:var(--muted)}dd{margin:0}
</style></head><body><main>${body}<p class="muted small">Secure link from ${esc(title.split(" · ")[1] ?? "the merchant")}. It only shows this one balance.</p></main></body></html>`)
  );
}

/**
 * Steps 7C.2 to 7C.5: the public pay-or-promise page. No login: the signed token is the only key,
 * and it opens exactly one balance. The page shows the amount, the reference and the merchant's
 * name, and nothing else about the customer. Amounts cannot be changed: nothing here accepts one.
 */
export async function payPageRoutes(
  app: FastifyInstance,
  deps: AppDeps & { payLinkSecret?: string; merchantName?: string },
): Promise<void> {
  await app.register(rateLimit, { global: false });
  // Plain HTML forms post urlencoded; parse just that, here.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 2048 },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  const merchant = deps.merchantName ?? "Boomerang Demo Store";
  const now = () => (deps.now ?? (() => new Date()))();

  async function open(token: string, reply: FastifyReply) {
    if (!deps.payLinkSecret)
      return {
        error: page(
          reply,
          503,
          `Payment link · ${merchant}`,
          `<div class="card"><h1>Payment links are not available</h1><p class="muted">Please use the link in the email from ${esc(merchant)}.</p></div>`,
        ),
      };
    const v = verifyPayLink(deps.payLinkSecret, token, now());
    if (!v.ok) {
      const why = v.reason === "expired" ? "This link has expired." : "This link is not valid.";
      return {
        error: page(
          reply,
          v.reason === "expired" ? 410 : 404,
          `Payment link · ${merchant}`,
          `<div class="card"><h1>${why}</h1><p class="muted">Please use the most recent email from ${esc(merchant)}, or contact them directly.</p></div>`,
        ),
      };
    }
    const [c] = await deps.db.db.select().from(cases).where(eq(cases.id, v.caseId));
    if (!c)
      return {
        error: page(
          reply,
          404,
          `Payment link · ${merchant}`,
          `<div class="card"><h1>This link is not valid.</h1></div>`,
        ),
      };
    return { c };
  }

  const view = (c: typeof cases.$inferSelect, token: string, notice = "") => {
    const today = isoDay(now());
    const max = isoDay(addDays(now(), PAY_PAGE_PROMISE_MAX_DAYS));
    const activePromise = c.promiseDate && c.promiseDate >= today ? c.promiseDate : null;
    const reference = c.lane === "invoice" ? `Invoice ${c.paypalRef}` : "Subscription payment";
    const payLabel = c.lane === "invoice" ? "Pay now with PayPal" : "Update your payment method in PayPal";
    const header = `<div class="card"><p class="muted small">${esc(merchant)}</p><h1>${esc(reference)}</h1><div class="amount">${esc(formatMoney(c.amountCents, c.currency))}</div>${c.dueDate ? `<p class="muted small">Was due ${esc(longDate(c.dueDate))}</p>` : ""}</div>`;
    if (c.state === "recovered")
      return `${header}<div class="card"><p class="ok"><strong>Paid. Thank you!</strong></p><p class="muted">Nothing more to do.</p></div>`;
    if (isEndState(c.state))
      return `${header}<div class="card"><p>This balance is now handled directly by ${esc(merchant)}. Please contact them.</p></div>`;
    const promise = activePromise
      ? `<p>You told us you will pay by <strong>${esc(longDate(activePromise))}</strong>. We will not remind you before then.</p>`
      : `<form method="post" action="/pay/${esc(token)}/promise"><h1>Need a little time?</h1><p class="muted small">Pick the day you will pay, up to ${PAY_PAGE_PROMISE_MAX_DAYS} days from today. We will hold reminders until then.</p><label for="date">I will pay by</label><input id="date" name="date" type="date" min="${today}" max="${max}" required><p></p><button class="button secondary" type="submit">Promise this date</button></form>`;
    return `${notice}${header}<div class="card"><a class="button" href="${esc(paypalPayLink(c))}" rel="noopener noreferrer">${payLabel}</a><p class="muted small">You will pay on PayPal's own page. ${c.lane === "invoice" ? "Card or PayPal balance." : ""}</p></div><div class="card">${promise}</div>`;
  };

  app.get<{ Params: { token: string } }>(
    "/pay/:token",
    { config: { rateLimit: { max: 60, timeWindow: "1 hour" } } },
    async (req, reply) => {
      const r = await open(req.params.token, reply);
      if ("error" in r) return r.error;
      return page(
        reply,
        200,
        `Pay ${formatMoney(r.c.amountCents, r.c.currency)} · ${merchant}`,
        view(r.c, req.params.token),
      );
    },
  );

  app.post<{ Params: { token: string }; Body: Record<string, unknown> }>(
    "/pay/:token/promise",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (req, reply) => {
      const r = await open(req.params.token, reply);
      if ("error" in r) return r.error;
      const c = r.c;
      const title = `Promise · ${merchant}`;
      const back = (msg: string, status: number) =>
        page(
          reply,
          status,
          title,
          view(c, req.params.token, `<div class="card"><p class="bad">${esc(msg)}</p></div>`),
        );

      // Only a date is accepted: any other field (an amount, a status) is refused outright.
      const body = req.body && typeof req.body === "object" ? req.body : {};
      if (Object.keys(body).some((k) => k !== "date")) return back("Only a date can be submitted here.", 400);
      const date = typeof body.date === "string" ? body.date : "";
      const today = isoDay(now());
      const max = isoDay(addDays(now(), PAY_PAGE_PROMISE_MAX_DAYS));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))
        return back("Please pick a date.", 400);
      if (date < today || date > max)
        return back(`Please pick a date between today and ${longDate(max)}.`, 400);
      if (isEndState(c.state)) return back("This balance can no longer be changed here.", 409);
      if (c.promiseDate && c.promiseDate >= today)
        return back(`You already promised ${longDate(c.promiseDate)}. One promise at a time.`, 409);
      // A promise already submitted but not yet processed by the worker also counts.
      const [waiting] = await deps.db.db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.type, REPLY_EVENT),
            eq(events.source, PAY_PAGE_SOURCE),
            eq(events.resourceId, c.paypalRef),
            isNull(events.processedAt),
          ),
        )
        .limit(1);
      if (waiting) return back("We already have your promise. One promise at a time.", 409);

      const id = `PAYPAGE-PROMISE-${c.id}-${Date.now()}`;
      const payload = {
        id,
        event_type: REPLY_EVENT,
        resource: {
          paypal_ref: c.paypalRef,
          lane: c.lane,
          classification: "promise",
          promise_date: date,
          source: PAY_PAGE_SOURCE,
        },
      };
      await deps.db.db.insert(events).values({
        paypalEventId: id,
        type: REPLY_EVENT,
        resourceId: c.paypalRef,
        payload,
        rawBody: JSON.stringify(payload),
        headers: {},
        source: PAY_PAGE_SOURCE,
        simulated: false,
      });
      req.log.info({ caseId: c.id, promiseDate: date }, "pay page promise recorded");
      return page(
        reply,
        200,
        title,
        `<div class="card"><p class="ok"><strong>Thank you. We have noted that you will pay by ${esc(longDate(date))}.</strong></p><p class="muted">We will not remind you before then. You can still pay any time:</p><a class="button" href="${esc(paypalPayLink(c))}" rel="noopener noreferrer">${c.lane === "invoice" ? "Pay now with PayPal" : "Update your payment method in PayPal"}</a></div>`,
      );
    },
  );
}
