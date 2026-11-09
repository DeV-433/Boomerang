import type { SimConfig } from "./config";
import { Rng } from "./rng";
import type { CustomerType, Lane, SimProfile } from "./types";

const GIVEN = [
  "Ava",
  "Liam",
  "Maya",
  "Noah",
  "Zoe",
  "Ethan",
  "Priya",
  "Lucas",
  "Isla",
  "Omar",
  "Mei",
  "Jonas",
  "Sara",
  "Diego",
  "Nina",
  "Arjun",
];
const FAMILY = [
  "Patel",
  "Garcia",
  "Smith",
  "Chen",
  "Kim",
  "Okafor",
  "Novak",
  "Rossi",
  "Silva",
  "Khan",
  "Müller",
  "Brown",
  "Ito",
  "Haddad",
];
const COMPANIES = [
  "Studio",
  "Labs",
  "Supply Co",
  "Consulting",
  "Bakery",
  "Fitness",
  "Design",
  "Logistics",
  "Dental",
  "Media",
];

/** PayPal reason codes for a failed subscription payment, by failure kind. */
const REASON_CODES = {
  soft: ["INTERNAL_SERVER_ERROR", "SENDING_LIMIT_EXCEEDED"],
  hard: ["PAYER_CANNOT_PAY", "PAYMENT_DENIED"],
} as const;

export interface PlannedCase {
  profile: SimProfile;
  customer: { name: string; email: string; payerRef: string; timezone: string | null };
  amountCents: number;
  currency: "USD";
  invoice?: { invoiceDate: string; dueDate: string; daysOverdue: number; description: string };
  subscription?: { id: string; planPriceCents: number; reasonCode: string; failedPayments: number };
}

export interface BatchPlan {
  seed: string;
  size: number;
  cases: PlannedCase[];
}

function isoDate(daysAgo: number, now: Date): string {
  return new Date(now.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Step 3.3 (pure part): plans a batch from a seed. The same seed, size and config always give the
 * same plan; `now` only anchors invoice dates relative to the day of seeding.
 */
export function planBatch(
  config: SimConfig,
  seed: string,
  size: number = config.batch.size,
  now: Date = new Date(),
): BatchPlan {
  const rng = new Rng(seed);
  const cases: PlannedCase[] = [];
  for (let i = 0; i < size; i++) {
    const lane: Lane = rng.weighted(config.batch.laneMix, "lane", i);
    const customerType: CustomerType = rng.weighted(config.batch.typeMix[lane], "type", i);
    const given = rng.pick(GIVEN, "given", i);
    const family = rng.pick(FAMILY, "family", i);
    const business = rng.chance(0.4, "is-business", i);
    const name = business ? `${family} ${rng.pick(COMPANIES, "company", i)}` : `${given} ${family}`;
    const customer = {
      name,
      email: `boomerang.sim+${seed}-${i}@example.com`,
      payerRef: `SIM${rng.id(10, "payer", i)}`,
      timezone: rng.pick(config.batch.timezones, "tz", i),
    };

    if (lane === "invoice") {
      const a = config.batch.invoiceAmount;
      const dollars = Math.min(
        a.maxDollars,
        Math.max(a.minDollars, a.medianDollars * Math.exp(a.spread * rng.normal("amount", i))),
      );
      const daysOverdue = rng.int(
        config.batch.invoiceDaysOverdue.min,
        config.batch.invoiceDaysOverdue.max,
        "overdue",
        i,
      );
      const termDays = rng.pick([14, 30, 45], "term", i);
      cases.push({
        profile: { batchIndex: i, lane, customerType, failureKind: null },
        customer,
        amountCents: Math.round(dollars * 100),
        currency: "USD",
        invoice: {
          invoiceDate: isoDate(daysOverdue + termDays, now),
          dueDate: isoDate(daysOverdue, now),
          daysOverdue,
          description: rng.pick(
            [
              "Consulting services",
              "Website maintenance",
              "Design work",
              "Monthly retainer",
              "Equipment rental",
              "Catering order",
            ],
            "desc",
            i,
          ),
        },
      });
    } else {
      const share = config.batch.softFailureShare[customerType] ?? 0;
      const failureKind =
        customerType === "needs_card_update" ? "hard" : rng.chance(share, "soft", i) ? "soft" : "hard";
      const weights = Object.fromEntries(
        config.batch.subscriptionPrices.map((p, k) => [String(k), config.batch.subscriptionPriceWeights[k]!]),
      );
      const price = config.batch.subscriptionPrices[Number(rng.weighted(weights, "price", i))]!;
      const priceCents = Math.round(price * 100);
      cases.push({
        profile: { batchIndex: i, lane, customerType, failureKind },
        customer,
        amountCents: priceCents,
        currency: "USD",
        subscription: {
          id: `I-SIM${rng.id(9, "sub", i)}`,
          planPriceCents: priceCents,
          reasonCode: rng.pick(REASON_CODES[failureKind], "reason", i),
          failedPayments: 1,
        },
      });
    }
  }
  return { seed, size, cases };
}
