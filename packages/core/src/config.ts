import { z } from "zod";
import { loadEnv } from "./env";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: optionalString,
  PAYPAL_CLIENT_ID: optionalString,
  PAYPAL_CLIENT_SECRET: optionalString,
  PAYPAL_WEBHOOK_ID: optionalString,
  PAYPAL_ENVIRONMENT: z.enum(["SANDBOX", "PRODUCTION"]).default("SANDBOX"),
  PAYPAL_SANDBOX_MERCHANT_EMAIL: optionalString,
  PAYPAL_SANDBOX_CUSTOMER_EMAIL: optionalString,
  GROQ_API_KEY: optionalString,
  /**
   * Extra Groq keys, comma-separated, each from a separate Groq organization (limits are per
   * organization). Used only by simulations and evals, never by the deployed worker.
   */
  GROQ_API_KEYS: optionalString,
  /** Requests per minute per Groq model; unset means no client-side limit (Groq's own headers still pace calls). */
  GROQ_RPM: z.coerce.number().positive().optional(),
  POLICY_MODE: z.enum(["dry_run", "live"]).default("dry_run"),
  PAY_LINK_SECRET: optionalString,
  SIM_WEBHOOK_SECRET: optionalString,
  /** Browser origins allowed to call the API (the dashboard), comma-separated. Local Vite dev is always allowed outside production. */
  DASHBOARD_ORIGINS: optionalString,
  /** Shared secret the operator types into the dashboard; every /api route requires it. Unset means /api is closed. */
  OPERATOR_TOKEN: optionalString,
});

export type Config = z.infer<typeof ConfigSchema>;

/** Parses configuration from the environment. Pass `env` explicitly in tests. */
export function loadConfig(env: NodeJS.ProcessEnv = (loadEnv(), process.env)): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}

/** Returns the value of a config key, or throws a clear error naming the missing variable. */
export function requireConfig<K extends keyof Config>(config: Config, key: K): NonNullable<Config[K]> {
  const value = config[key];
  if (value === undefined || value === null) {
    throw new Error(`Missing required environment variable ${String(key)}`);
  }
  return value as NonNullable<Config[K]>;
}

/** GROQ_API_KEY followed by any GROQ_API_KEYS, for batch work (simulations, evals). Throws if there is none. */
export function groqKeys(config: Config): string[] {
  const keys = [config.GROQ_API_KEY, ...(config.GROQ_API_KEYS ?? "").split(",")]
    .map((k) => k?.trim() ?? "")
    .filter(Boolean);
  const unique = [...new Set(keys)];
  if (unique.length === 0) throw new Error("GROQ_API_KEY is not set");
  return unique;
}
