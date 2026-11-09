import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PayPalAPI, PayPalMCPToolkit } from "@paypal/agent-toolkit/mcp";
import { parseRetryAfter, PayPalHttpError } from "./http";

/**
 * The only module that touches @paypal/agent-toolkit. Everything else goes through the gateway,
 * which adds the whitelist, argument validation, token refresh, idempotency and retries.
 */

/** A require() rooted at the toolkit, so "axios" resolves to the exact copy the toolkit uses. */
const toolkitRequire = createRequire(createRequire(import.meta.url).resolve("@paypal/agent-toolkit/mcp"));

/** Version of the installed toolkit, read from its own package.json (it is not exported). */
export function toolkitVersion(): string {
  let dir = dirname(toolkitRequire.resolve("@paypal/agent-toolkit/mcp"));
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@paypal/agent-toolkit" && pkg.version) return pkg.version;
    } catch {
      // keep walking up
    }
    dir = dirname(dir);
  }
  return "unknown";
}

/** Exact version this code was written and contract-tested against (step 2.10). */
export const PINNED_TOOLKIT_VERSION = "1.11.0";

export interface ToolDefinition {
  method: string;
  name: string;
  /** Zod schema shipped with the toolkit. */
  parameters: { safeParse(input: unknown): { success: boolean; data?: unknown; error?: { issues: { path: (string | number)[]; message: string }[] } }; shape?: Record<string, unknown> };
  /** The configuration flag that enables this tool, e.g. { invoices: { sendReminder: true } }. */
  actions: Record<string, Record<string, boolean>>;
}

let registryCache: Map<string, ToolDefinition> | null = null;

/**
 * Every tool the installed toolkit knows about, keyed by method name. Built by asking the toolkit
 * for its tools with every action flag switched on, then reading back what it reports.
 */
export function toolRegistry(): Map<string, ToolDefinition> {
  if (registryCache) return registryCache;
  // A configuration that answers "true" for every product and action flag.
  const everything = new Proxy({} as Record<string, Record<string, boolean>>, {
    get: () => new Proxy({}, { get: () => true }),
  });
  const toolkit = new PayPalMCPToolkit({
    accessToken: "registry-only",
    configuration: { actions: everything, context: { sandbox: true } },
  } as ConstructorParameters<typeof PayPalMCPToolkit>[0]);
  registryCache = new Map(
    (toolkit.getTools() as unknown as ToolDefinition[]).map((tool) => [tool.method, tool] as const),
  );
  return registryCache;
}

// Capturing full error responses -----------------------------------------------------------------------

interface CapturedResponse {
  status: number;
  body: string;
  debugId: string | null;
  retryAfterMs: number | null;
}

const capture = new AsyncLocalStorage<{ lastError: CapturedResponse | null }>();
let interceptorInstalled = false;

/**
 * The toolkit turns HTTP errors into a message cut to 200 characters and drops PayPal's debug id
 * and Retry-After. A response interceptor on the toolkit's own axios instance records the full
 * error for the call in progress, so the gateway can log and retry properly.
 */
function installErrorCapture(): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;
  const axios = toolkitRequire("axios") as {
    interceptors: { response: { use(ok: (r: unknown) => unknown, fail: (e: unknown) => unknown): void } };
  };
  axios.interceptors.response.use(
    (response) => response,
    (error) => {
      const store = capture.getStore();
      const res = (error as { response?: { status: number; data: unknown; headers?: Record<string, string> } })
        .response;
      if (store && res) {
        store.lastError = {
          status: res.status,
          body: typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? null),
          debugId: res.headers?.["paypal-debug-id"] ?? null,
          retryAfterMs: parseRetryAfter(res.headers?.["retry-after"]),
        };
      }
      return Promise.reject(error);
    },
  );
}

export interface ToolkitCallOptions {
  accessToken: string;
  sandbox: boolean;
  /** Sent as PayPal-Request-Id, PayPal's idempotency header. */
  requestId?: string;
}

/**
 * Executes one toolkit tool and returns PayPal's parsed response, or throws PayPalHttpError.
 * A fresh PayPalAPI is built per call so each call carries the current token and its own request id.
 */
export async function runToolkitMethod(method: string, args: unknown, options: ToolkitCallOptions): Promise<unknown> {
  installErrorCapture();
  const api = new PayPalAPI(options.accessToken, {
    sandbox: options.sandbox,
    ...(options.requestId ? { request_id: options.requestId } : {}),
  });
  // executeMethod throws on failure; the public run() would hide the error inside a JSON string.
  const execute = (api as unknown as { executeMethod(m: string, a: unknown): Promise<unknown> }).executeMethod.bind(api);
  const store = { lastError: null as CapturedResponse | null };
  return capture.run(store, async () => {
    try {
      return await execute(method, args);
    } catch (error) {
      const e = error as { status?: number; code?: string; message?: string };
      const full = store.lastError;
      if (full) throw new PayPalHttpError(full.status, full.body, full.debugId, method, full.retryAfterMs);
      if (e.code === "PAYPAL_API_NO_RESPONSE") throw new PayPalHttpError(null, e.message ?? "", null, method);
      throw new PayPalHttpError(e.status ?? null, e.message ?? String(error), null, method);
    }
  });
}
