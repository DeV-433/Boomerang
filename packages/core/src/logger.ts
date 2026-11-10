import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";

/** Paths that must never reach the logs, whatever their value (9.7). */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "*.access_token",
  "*.client_secret",
  "*.password",
  "*.secret",
  "*.apiKey",
  "*.api_key",
  "*.email",
  "*.email_address",
  "*.full_name",
  "*.given_name",
  "*.surname",
  "*.phone",
  "*.customerName",
  // Database errors carry the query's parameters (message bodies, names): never log them.
  "err.params",
  "*.params",
];

/**
 * 9.7: patterns scrubbed from every logged string, wherever they appear (messages, error text,
 * PayPal error bodies, URLs). Order matters: the pay-page token before generic patterns.
 */
const SCRUBBERS: [RegExp, string][] = [
  [/\nparams: [\s\S]*?(?=\n\s+at |$)/g, "\nparams: [redacted]"],
  [/\/pay\/[^\s/?#"'<>]+/g, "/pay/[token]"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/Bearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]"],
  [/\bgsk_[A-Za-z0-9]{8,}/g, "[groq-key]"],
  [/\bA21AA[\w-]{16,}/g, "[paypal-token]"],
  [/\bt=\d+,v1=[0-9a-f]{16,}/g, "[sim-signature]"],
];

export function scrub(text: string): string {
  let out = text;
  for (const [re, by] of SCRUBBERS) out = out.replace(re, by);
  return out;
}

/** Keeps the network, drops the host: 203.0.113.7 -> 203.0.113.0, IPv6 to its first 3 groups. */
export function anonymizeIp(ip: string | undefined): string | undefined {
  if (!ip) return ip;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.replace(/\.\d+$/, ".0");
  if (ip.includes(":")) return `${ip.split(":").slice(0, 3).join(":")}::`;
  return ip;
}

function scrubDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrub(value);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (value instanceof Error)
    return {
      type: value.name,
      message: scrub(value.message),
      stack: value.stack ? scrub(value.stack) : undefined,
      ...(scrubDeep({ ...value }, depth + 1) as object),
    };
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
  // Only plain objects: request and response objects are left to their serializers below.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, depth + 1)]));
}

interface RequestLike {
  method?: string;
  url?: string;
  ip?: string;
  hostname?: string;
  socket?: { remoteAddress?: string };
}

export function createLogger(options: LoggerOptions = {}, destination?: DestinationStream): Logger {
  const opts: LoggerOptions = {
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    formatters: { log: (obj) => scrubDeep(obj) as Record<string, unknown> },
    hooks: {
      logMethod(args, method) {
        method.apply(
          this,
          args.map((a) => (typeof a === "string" ? scrub(a) : a)) as Parameters<typeof method>,
        );
      },
    },
    serializers: {
      // Fastify's request log: method and URL (pay-page token cut), and a truncated client address.
      req: (req: RequestLike) => ({
        method: req.method,
        url: req.url ? scrub(req.url) : req.url,
        hostname: req.hostname,
        remoteAddress: anonymizeIp(req.ip ?? req.socket?.remoteAddress),
      }),
      err: (err: unknown) => scrubDeep(pino.stdSerializers.err(err as Error)),
    },
    ...options,
  };
  return destination ? pino(opts, destination) : pino(opts);
}

export type { Logger };
