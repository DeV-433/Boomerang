import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CONTACT_KINDS, CUSTOMER_TYPES } from "./types";

const probability = z.number().min(0).max(1);
const range = z
  .object({ min: z.number(), max: z.number() })
  .refine((r) => r.min <= r.max, "min must be <= max");

const responseRow = z
  .object({ pay: probability, promise: probability, dispute: probability, optOut: probability })
  .refine(
    (r) => r.pay + r.promise + r.dispute + r.optOut <= 1 + 1e-9,
    "probabilities must sum to at most 1 (rest is ignore)",
  );

const contactKey = z.enum(["default", ...CONTACT_KINDS]);
const byType = <T extends z.ZodTypeAny>(schema: T) =>
  z.object(
    Object.fromEntries(CUSTOMER_TYPES.map((t) => [t, schema])) as Record<(typeof CUSTOMER_TYPES)[number], T>,
  );
const mix = z.partialRecord(z.enum(CUSTOMER_TYPES), probability);

/**
 * Step 3.1: the customer-behaviour model. Every number the simulator uses lives in
 * sim/config/simulator.json; see sim/README.md for what each one means.
 */
export const SimConfigSchema = z
  .object({
    version: z.number().int(),
    horizonDays: z.number().int().positive(),
    batch: z.object({
      size: z.number().int().positive(),
      laneMix: z.object({ invoice: probability, subscription: probability }),
      typeMix: z.object({ invoice: mix, subscription: mix }),
      invoiceAmount: z.object({
        medianDollars: z.number().positive(),
        spread: z.number().nonnegative(),
        minDollars: z.number(),
        maxDollars: z.number(),
      }),
      subscriptionPrices: z.array(z.number().positive()).min(1),
      subscriptionPriceWeights: z.array(z.number().nonnegative()).min(1),
      invoiceDaysOverdue: range,
      softFailureShare: z.partialRecord(z.enum(CUSTOMER_TYPES), probability),
      timezones: z.array(z.string().nullable()).min(1),
    }),
    responses: z
      .record(z.enum(CUSTOMER_TYPES), z.partialRecord(contactKey, responseRow))
      .refine(
        (r) => CUSTOMER_TYPES.every((t) => r[t]?.default),
        "every customer type needs a default response row",
      ),
    fatigue: z.object({ perPriorContact: probability, optOutIncreasePerPriorContact: probability }),
    payDelayDays: range,
    promise: z.object({ inDays: range, keepProbability: byType(probability) }),
    /**
     * 7C.7: the self-serve pay page. A customer who would have ignored a Boomerang reminder sometimes
     * opens its link instead: some pay there and then, the rest promise a date (kept at their type's
     * usual promise-keeping rate). Optional, so batches stored before 7C replay unchanged.
     */
    payPage: z
      .object({
        useProbability: byType(probability),
        payShare: byType(probability),
        promiseInDays: range,
      })
      .optional(),
    dailySelfPay: byType(probability),
    paypalRetry: z.object({
      intervalDays: z.number().int().positive(),
      maxRetriesPerCycle: z.number().int().nonnegative(),
      paymentFailureThreshold: z.number().int().positive(),
      softSuccessProbability: probability,
      afterCardUpdateSuccessProbability: probability,
    }),
    baseline: z.object({
      invoiceReminderDays: z.array(z.number().int().nonnegative()),
      subscriptionDunningDays: z.array(z.number().int().nonnegative()),
    }),
  })
  .superRefine((c, ctx) => {
    const sum = (o: Partial<Record<string, number>>) =>
      Object.values(o).reduce((a: number, b) => a + (b ?? 0), 0);
    const near1 = (n: number) => Math.abs(n - 1) < 1e-6;
    if (!near1(c.batch.laneMix.invoice + c.batch.laneMix.subscription))
      ctx.addIssue({ code: "custom", message: "laneMix must sum to 1" });
    for (const lane of ["invoice", "subscription"] as const) {
      if (!near1(sum(c.batch.typeMix[lane])))
        ctx.addIssue({ code: "custom", message: `typeMix.${lane} must sum to 1` });
    }
    if (c.batch.subscriptionPrices.length !== c.batch.subscriptionPriceWeights.length) {
      ctx.addIssue({
        code: "custom",
        message: "subscriptionPrices and subscriptionPriceWeights differ in length",
      });
    }
  });

export type SimConfig = z.infer<typeof SimConfigSchema>;

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../config/simulator.json", import.meta.url));

export function loadSimConfig(path: string = DEFAULT_CONFIG_PATH): SimConfig {
  return parseSimConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function parseSimConfig(raw: unknown): SimConfig {
  const parsed = SimConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid simulator config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/** Returns a copy with some values replaced, for sensitivity runs (9.2) and what-if replays (7A). */
export function withOverrides(config: SimConfig, patch: (draft: SimConfig) => void): SimConfig {
  const copy = structuredClone(config);
  patch(copy);
  return parseSimConfig(copy);
}
