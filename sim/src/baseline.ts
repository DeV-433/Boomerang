import type { SimConfig } from "./config";
import type { Strategy } from "./engine";

/**
 * Step 3.7: what a merchant gets by default. Invoices: PayPal's fixed reminder schedule.
 * Subscriptions: PayPal's retries (in the engine) plus a fixed dunning email schedule.
 * No diagnosis, no promise tracking, and it does not stop for opt-outs or disputes, because a
 * fixed schedule never reads replies. Only payment stops it.
 */
export function baselineStrategy(config: SimConfig): Strategy {
  const invoiceDays = new Set(config.baseline.invoiceReminderDays);
  const dunningDays = new Set(config.baseline.subscriptionDunningDays);
  return {
    name: "baseline-fixed-schedule",
    contactsFor: ({ lane, day }) =>
      (lane === "invoice" ? invoiceDays : dunningDays).has(day) ? ["generic_reminder"] : [],
  };
}
