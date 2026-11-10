import type { SimSettings } from "@boomerang/core";

type Cfg = {
  horizonDays?: number;
  batch?: {
    laneMix?: { invoice: number; subscription: number };
    invoiceAmount?: { medianDollars: number };
    invoiceDaysOverdue?: { min: number; max: number };
  };
  fatigue?: { perPriorContact: number; optOutIncreasePerPriorContact: number };
  payDelayDays?: { min: number; max: number };
  promise?: { inDays: { min: number; max: number } };
  paypalRetry?: { intervalDays: number; maxRetriesPerCycle: number; paymentFailureThreshold: number };
  baseline?: { invoiceReminderDays: number[]; subscriptionDunningDays: number[] };
  payPage?: unknown;
};

const share = (v: number | undefined) => (v === undefined ? "n/a" : `${Math.round(v * 100)}%`);
const range = (r: { min: number; max: number } | undefined, unit: string) =>
  r ? `${r.min}–${r.max} ${unit}` : "n/a";

/** 9.3: the simulator settings and seed beside every simulated result. */
export function SimSettingsPanel({ settings }: { settings: SimSettings }) {
  const c = settings.config as Cfg;
  const rows: [string, string][] = [
    ["Batch", `${settings.batchName} · ${settings.batchSize} cases · ${settings.batchMode}`],
    ["Horizon", c.horizonDays ? `${c.horizonDays} days` : "n/a"],
    [
      "Lane mix",
      `${share(c.batch?.laneMix?.invoice)} invoices, ${share(c.batch?.laneMix?.subscription)} subscriptions`,
    ],
    [
      "Invoices",
      `median $${c.batch?.invoiceAmount?.medianDollars ?? "?"}, ${range(c.batch?.invoiceDaysOverdue, "days overdue")}`,
    ],
    [
      "Fatigue",
      c.fatigue
        ? `×${c.fatigue.perPriorContact} per earlier message, opt-out +${share(c.fatigue.optOutIncreasePerPriorContact)}`
        : "n/a",
    ],
    ["Pay delay", range(c.payDelayDays, "days")],
    ["Promises", range(c.promise?.inDays, "days ahead")],
    [
      "PayPal retries",
      c.paypalRetry
        ? `every ${c.paypalRetry.intervalDays} d, ${c.paypalRetry.maxRetriesPerCycle} per cycle, suspend at ${c.paypalRetry.paymentFailureThreshold}`
        : "n/a",
    ],
    [
      "Baseline days",
      c.baseline
        ? `invoices ${c.baseline.invoiceReminderDays.join(", ")}; subscriptions ${c.baseline.subscriptionDunningDays.join(", ")}`
        : "n/a",
    ],
    ["Pay page", c.payPage ? "modelled" : "not modelled"],
  ];
  return (
    <div className="settings" data-testid="sim-settings">
      <div className="settings-seed">
        <span className="tile-label">Seed</span>
        <span className="settings-seed-value">{settings.seed}</span>
        <span className="chip" title="First 12 characters of the SHA-256 of the simulator config">
          config {settings.configHash}
        </span>
        {!settings.sameConfigBothArms && (
          <span className="chip chip-warn">arms ran with different configs</span>
        )}
      </div>
      <dl className="settings-list">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <details className="table-view">
        <summary>Full simulator config</summary>
        <pre className="settings-json">{JSON.stringify(settings.config, null, 2)}</pre>
      </details>
    </div>
  );
}
