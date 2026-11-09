import type { SimConfig } from "./config";
import type { Rng } from "./rng";
import type { ContactKind, CustomerType, Outcome } from "./types";

export interface Response {
  outcome: Outcome;
  /** For "pay": days after the contact until the money arrives. */
  payInDays?: number;
  /** For "promise": the promised payment day, relative to the contact. */
  promiseInDays?: number;
  /** For "promise": whether the customer will actually keep it (decided now, revealed later). */
  promiseKept?: boolean;
}

/** The outcome probabilities a customer type has for one contact, after fatigue. Exposed for tests and the dashboard. */
export function responseProbabilities(
  config: SimConfig,
  type: CustomerType,
  contact: ContactKind,
  priorContacts: number,
): Record<Outcome, number> {
  const table = config.responses[type]!;
  const row = table[contact] ?? table.default!;
  const fatigue = config.fatigue.perPriorContact ** priorContacts;
  const optOut = Math.min(1, row.optOut + config.fatigue.optOutIncreasePerPriorContact * priorContacts);
  const pay = row.pay * fatigue;
  const promise = row.promise * fatigue;
  const dispute = row.dispute;
  // Scale down if fatigue arithmetic pushed the total over 1, keeping ignore >= 0.
  const total = pay + promise + dispute + optOut;
  const k = total > 1 ? 1 / total : 1;
  const p = { pay: pay * k, promise: promise * k, dispute: dispute * k, opt_out: optOut * k };
  return { ...p, ignore: Math.max(0, 1 - (p.pay + p.promise + p.dispute + p.opt_out)) };
}

/**
 * Step 3.6: how a customer of a given hidden type answers one contact. The answer depends on the
 * type, on whether the contact fits it (a card-update message for a card problem, a payment plan
 * for someone who needs time), and on how many contacts came before.
 * `drawKey` identifies this contact so the same contact always gets the same answer.
 */
export function respond(
  config: SimConfig,
  rng: Rng,
  type: CustomerType,
  contact: ContactKind,
  priorContacts: number,
  drawKey: (string | number)[],
): Response {
  const p = responseProbabilities(config, type, contact, priorContacts);
  let roll = rng.draw(...drawKey, "outcome");
  const order: Outcome[] = ["pay", "promise", "dispute", "opt_out", "ignore"];
  let outcome: Outcome = "ignore";
  for (const o of order) {
    if (roll < p[o]) {
      outcome = o;
      break;
    }
    roll -= p[o];
  }
  if (outcome === "pay") {
    return {
      outcome,
      payInDays: rng.int(config.payDelayDays.min, config.payDelayDays.max, ...drawKey, "pay-delay"),
    };
  }
  if (outcome === "promise") {
    return {
      outcome,
      promiseInDays: rng.int(
        config.promise.inDays.min,
        config.promise.inDays.max,
        ...drawKey,
        "promise-days",
      ),
      promiseKept: rng.chance(config.promise.keepProbability[type], ...drawKey, "promise-kept"),
    };
  }
  return { outcome };
}
