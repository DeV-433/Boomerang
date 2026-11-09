import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { TokenManager } from "../src/auth";
import { PayPalGateway } from "../src/gateway";
import { MemoryIdempotencyStore, type IdempotencyStore } from "../src/idempotency";

export const BASE = "https://api-m.sandbox.paypal.com";
/** The toolkit sends requests to the legacy sandbox host when given an access token. Both are faked. */
const HOSTS = ["https://api-m.sandbox.paypal.com", "https://api.sandbox.paypal.com"];
export const INVOICE_ID = "INV2-ABCD-EFGH-JKLM-NPQR";
export const SUBSCRIPTION_ID = "I-BW452GLLEP1G";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A minimal fake of the PayPal sandbox at the network layer. Intercepts both the toolkit's axios
 * calls and our own fetch calls, records every request, and lets tests script failures.
 */
export function fakePayPal() {
  const requests: RecordedRequest[] = [];
  /** Responses to return before falling back to the default handler, per "METHOD /path". */
  const scripted = new Map<string, Response[]>();
  let tokenCounter = 0;

  const record = async (request: Request): Promise<RecordedRequest> => {
    const url = new URL(request.url);
    const text = await request.clone().text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // form-encoded token request
    }
    const entry = {
      method: request.method,
      path: url.pathname,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    };
    requests.push(entry);
    return entry;
  };

  const next = (key: string): Response | undefined => scripted.get(key)?.shift();

  const unexpected: string[] = [];
  const server = setupServer(
    http.post(`${BASE}/v1/oauth2/token`, async ({ request }) => {
      await record(request);
      return (
        next("POST /v1/oauth2/token") ??
        HttpResponse.json({ access_token: `token-${++tokenCounter}`, expires_in: 32400 })
      );
    }),
    ...HOSTS.map((host) =>
      http.all(`${host}/*`, async ({ request }) => {
        const r = await record(request);
        const scriptedResponse = next(`${r.method} ${r.path}`);
        if (scriptedResponse) return scriptedResponse;
        if (r.headers.authorization === "Bearer revoked") {
          return HttpResponse.json({ name: "AUTHENTICATION_FAILURE" }, { status: 401 });
        }
        if (r.method === "GET" && r.path === "/v2/invoicing/invoices") {
          return HttpResponse.json({
            items: [{ id: INVOICE_ID, status: "SENT" }],
            total_items: 1,
            total_pages: 1,
          });
        }
        if (r.method === "GET" && r.path.startsWith("/v2/invoicing/invoices/")) {
          return HttpResponse.json({
            id: r.path.split("/").pop(),
            status: "SENT",
            detail: { currency_code: "USD" },
          });
        }
        if (r.method === "POST" && /\/(remind|cancel-reminders)$/.test(r.path))
          return new HttpResponse(null, { status: 204 });
        if (r.method === "POST" && r.path.endsWith("/generate-qr-code"))
          return HttpResponse.text("iVBORw0KGgo=");
        if (r.method === "POST" && r.path.endsWith("/payments"))
          return HttpResponse.json({ payment_id: "EXTR-1" });
        if (r.method === "GET" && r.path.startsWith("/v1/billing/subscriptions/")) {
          return HttpResponse.json({
            id: SUBSCRIPTION_ID,
            status: "ACTIVE",
            billing_info: {
              failed_payments_count: 2,
              outstanding_balance: { currency_code: "USD", value: "15.00" },
            },
          });
        }
        if (r.method === "POST" && r.path.endsWith("/capture"))
          return HttpResponse.json({ id: "CAP-1", status: "COMPLETED" });
        return HttpResponse.json({ name: "RESOURCE_NOT_FOUND", path: r.path }, { status: 404 });
      }),
    ),
    // Anything else must never leave the machine: answer it here and remember it, so tests can fail.
    http.all("*", ({ request }) => {
      unexpected.push(`${request.method} ${request.url}`);
      return HttpResponse.json({ name: "UNEXPECTED_HOST_IN_TEST" }, { status: 599 });
    }),
  );

  return {
    server,
    requests,
    /** Requests to hosts other than PayPal's sandbox. Must stay empty. */
    unexpected,
    /** Queue responses for "METHOD /path" before the default handler applies. */
    script(key: string, ...responses: Response[]) {
      scripted.set(key, [...(scripted.get(key) ?? []), ...responses]);
    },
    callsTo(method: string, pathSuffix: string) {
      return requests.filter((r) => r.method === method && r.path.endsWith(pathSuffix));
    },
    reset() {
      requests.length = 0;
      unexpected.length = 0;
      scripted.clear();
      tokenCounter = 0;
    },
  };
}

export function makeGateway(options: { idempotency?: IdempotencyStore; sleeps?: number[] } = {}) {
  const tokens = new TokenManager({ clientId: "id", clientSecret: "secret", environment: "SANDBOX" });
  const sleeps = options.sleeps ?? [];
  const gateway = new PayPalGateway({
    tokens,
    idempotency: options.idempotency ?? new MemoryIdempotencyStore(),
    retry: {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    },
  });
  return { gateway, tokens, sleeps };
}
