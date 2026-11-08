import { pino, type Logger, type LoggerOptions } from "pino";

/** Paths that must never reach the logs (BUILD_PLAN 9.7 builds on this list). */
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
];

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...options,
  });
}

export type { Logger };
