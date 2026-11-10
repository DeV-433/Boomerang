import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ArmTotals, SimArmMetrics, SummaryResponse } from "@boomerang/core";
import { api } from "../api";
import { count, dateTime, money, pct, points, usd } from "../format";
import { IntervalPlot, type IntervalRow } from "../IntervalPlot";
import { SimSettingsPanel } from "../SimSettingsPanel";

/** Dollars large, cents small and muted, like a ledger total. */
function BigMoney({ cents }: { cents: number }) {
  const [whole, frac] = money(cents).split(".");
  return (
    <span className="big-money">
      {whole}
      <span className="big-money-cents">.{frac}</span>
    </span>
  );
}

function Delta({ value }: { value: number | null }) {
  if (value === null) return null;
  const cls = value > 0.05 ? "delta-up" : value < -0.05 ? "delta-down" : "delta-flat";
  return <span className={`delta ${cls}`}>{points(value)}</span>;
}

function Tile({ label, value, sub, hero }: { label: string; value: string; sub?: string; hero?: boolean }) {
  return (
    <div className={`tile${hero ? " tile-hero" : ""}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

/**
 * Meter per arm: the track is the amount at risk, the fill is the amount recovered. One series,
 * so no legend; the arm names and values are printed beside each bar, and hover repeats them.
 */
function RecoveryMeters({ rows }: { rows: { name: string; totals: ArmTotals }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.totals.atRiskCents));
  return (
    <div
      className="meters"
      role="img"
      aria-label={rows
        .map(
          (r) =>
            `${r.name}: ${money(r.totals.recoveredCents)} recovered of ${money(r.totals.atRiskCents)} (${pct(r.totals.recoveryRate)})`,
        )
        .join("; ")}
    >
      {rows.map((r) => {
        const track = (r.totals.atRiskCents / max) * 100;
        const fill = r.totals.atRiskCents === 0 ? 0 : (r.totals.recoveredCents / r.totals.atRiskCents) * 100;
        const tip = `${r.name}: ${money(r.totals.recoveredCents)} recovered of ${money(r.totals.atRiskCents)} at risk (${pct(r.totals.recoveryRate)})`;
        return (
          <div className="meter-row" key={r.name}>
            <div className="meter-name">{r.name}</div>
            <div className="meter-area">
              <div
                className="meter-track"
                style={{ width: `${track}%` }}
                title={tip}
                tabIndex={0}
                aria-label={tip}
              >
                <div className="meter-fill" style={{ width: `${fill}%` }} />
              </div>
            </div>
            <div className="meter-value">
              <strong>{pct(r.totals.recoveryRate)}</strong>{" "}
              <span className="muted">
                {money(r.totals.recoveredCents, { compact: true })} of{" "}
                {money(r.totals.atRiskCents, { compact: true })}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const ROWS: { label: string; get: (m: SimArmMetrics) => string }[] = [
  { label: "Cases", get: (m) => count(m.cases) },
  { label: "At risk", get: (m) => money(m.atRiskCents) },
  { label: "Recovered", get: (m) => money(m.recoveredCents) },
  { label: "Recovery rate", get: (m) => pct(m.recoveryRate) },
  { label: "Recovered cases", get: (m) => count(m.recoveredCases) },
  { label: "Contacts sent", get: (m) => count(m.contacts) },
  {
    label: "Contacts per recovered dollar",
    get: (m) => (m.contactsPerRecoveredDollar === null ? "n/a" : m.contactsPerRecoveredDollar.toFixed(4)),
  },
  {
    label: "Median days to recovery",
    get: (m) => (m.medianDaysToRecovery === null ? "n/a" : String(m.medianDaysToRecovery)),
  },
  { label: "Contacts after opt-out", get: (m) => count(m.contactsAfterOptOut) },
  { label: "Disputes", get: (m) => count(m.disputes) },
  { label: "Escalated to a person", get: (m) => (m.escalated === undefined ? "n/a" : count(m.escalated)) },
  { label: "Used the pay page", get: (m) => (m.payPageUses === undefined ? "n/a" : count(m.payPageUses)) },
];

export function Summary() {
  const [treatmentRun, setTreatmentRun] = useState<string>("");
  const summary = useQuery({
    queryKey: ["summary", treatmentRun],
    queryFn: ({ signal }) =>
      api<SummaryResponse>(`/api/summary${treatmentRun ? `?treatmentRun=${treatmentRun}` : ""}`, { signal }),
    refetchInterval: 30_000,
  });

  if (summary.isPending) return <p className="muted">Loading summary...</p>;
  if (summary.isError) return <p className="error">Could not load the summary: {summary.error.message}</p>;
  const s = summary.data;
  const sim = s.simulated;
  const ctl = sim.control?.metrics;
  const trt = sim.treatment?.metrics;
  const intervals: IntervalRow[] = [];
  if (sim.upliftPoints !== null && sim.interval)
    intervals.push({
      name: "vs control arm",
      estimate: sim.upliftPoints,
      low: sim.interval.low,
      high: sim.interval.high,
      note: "different cases in each arm, so part of the gap is luck of the split",
    });
  if (sim.sameCases)
    intervals.push({
      name: "vs baseline, same cases",
      estimate: sim.sameCases.upliftPoints,
      low: sim.sameCases.interval.low,
      high: sim.sameCases.interval.high,
      note: `the baseline would recover ${pct(sim.sameCases.baselineRate)} of the treatment arm`,
    });
  const today = new Date();

  return (
    <div className="summary">
      <div className="page-head">
        <h1>Recovery summary</h1>
        <span className="date-chip">
          <span className="date-chip-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="5" width="18" height="16" rx="3" />
              <path d="M3 10h18M8 3v4M16 3v4" />
            </svg>
          </span>
          <span>
            <span className="date-chip-day">
              {today.toLocaleDateString(undefined, { day: "numeric", month: "long" })}
            </span>
            <span className="date-chip-year">{today.getFullYear()}</span>
          </span>
        </span>
        <div className="chips">
          <span className="chip">{s.batch ? s.batch.name : "no batch"}</span>
          <span className={`chip ${s.system.mode === "live" ? "chip-accent" : ""}`}>
            {s.system.mode === "live" ? "Live mode" : "Dry run"}
          </span>
          {s.system.paused && <span className="chip chip-warn">Paused</span>}
          <span className="chip">
            {s.batch?.startedAt ? `Batch started ${dateTime(s.batch.startedAt)}` : "Batch not started"}
          </span>
        </div>
      </div>

      {ctl && trt ? (
        <div className="bento">
          <section className="card span-5">
            <div className="card-head">
              <h2>Recovered by Boomerang</h2>
              {sim.runs.filter((r) => r.arm === "treatment").length > 1 && (
                <label className="picker">
                  <span className="sr-only">Treatment run</span>
                  <select
                    value={treatmentRun || sim.treatment?.id || ""}
                    onChange={(e) => setTreatmentRun(e.target.value)}
                  >
                    {sim.runs
                      .filter((r) => r.arm === "treatment")
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.strategy} ({dateTime(r.startedAt)})
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
            <div className="hero-line">
              <BigMoney cents={trt.recoveredCents} />
              <Delta value={sim.upliftPoints} />
            </div>
            <p className="tile-sub">
              {pct(trt.recoveryRate)} of {money(trt.atRiskCents, { compact: true })} at risk in the treatment
              arm ({sim.treatment!.strategy}); the control arm recovered {pct(ctl.recoveryRate)}.
            </p>
            <h3>Recovery rate</h3>
            <RecoveryMeters
              rows={[
                { name: "Control (fixed schedule)", totals: ctl },
                { name: `Treatment (${sim.treatment!.strategy})`, totals: trt },
              ]}
            />
          </section>

          <section className="card span-4">
            <h2>Uplift and interval</h2>
            <div className="hero-line">
              <span className="big-number">
                {sim.upliftPoints === null
                  ? "n/a"
                  : `${sim.upliftPoints > 0 ? "+" : sim.upliftPoints < 0 ? "−" : ""}${Math.abs(sim.upliftPoints).toFixed(1)}`}
                <span className="accent big-number-unit">pts</span>
              </span>
            </div>
            <p className="tile-sub">
              Treatment minus control recovery rate.
              {sim.interval &&
                ` ${Math.round(sim.interval.level * 100)}% bootstrap interval ${sim.interval.low.toFixed(1)} to ${sim.interval.high.toFixed(1)} points (${count(sim.interval.iterations)} resamples).`}
            </p>
            <IntervalPlot rows={intervals} level={sim.interval?.level} />
            <div className="tiles">
              <Tile
                label="Contacts sent"
                value={count(trt.contacts)}
                sub={`control sent ${count(ctl.contacts)}`}
              />
              <Tile
                label="After opt-out"
                value={count(trt.contactsAfterOptOut)}
                sub={`control: ${count(ctl.contactsAfterOptOut)}`}
              />
            </div>
          </section>

          <section className="card span-3 rows-2 card-accent">
            <h2>Simulator settings</h2>
            {sim.settings ? (
              <SimSettingsPanel settings={sim.settings} />
            ) : (
              <p className="muted">No settings stored.</p>
            )}
          </section>

          <section className="card span-5">
            <h2>All metrics</h2>
            <table>
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col">Control</th>
                  <th scope="col">Treatment</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td>{row.get(ctl)}</td>
                    <td>{row.get(trt)}</td>
                  </tr>
                ))}
                {trt.modelCostPerRecoveredDollar != null && (
                  <tr>
                    <th scope="row">Model cost per recovered dollar</th>
                    <td>n/a</td>
                    <td>
                      {usd(trt.modelCostPerRecoveredDollar, 6)}
                      {trt.model ? ` (${usd(trt.model.all.costUsd)} for the run)` : ""}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="note">
              Simulated customers: this reflects the simulator's assumptions, not real-world proof.
            </p>
          </section>

          <LiveCard s={s} className="span-4" />
        </div>
      ) : (
        <div className="bento">
          <section className="card span-12">
            <h2>Simulated result</h2>
            <p className="muted">No finished simulation runs for this batch yet.</p>
          </section>
          <LiveCard s={s} className="span-12" />
        </div>
      )}
    </div>
  );
}

function LiveCard({ s, className }: { s: SummaryResponse; className: string }) {
  return (
    <section className={`card ${className}`}>
      <h2>Live cases in the database</h2>
      <div className="tiles tiles-2">
        <Tile
          label="Control arm"
          value={pct(s.live.control.recoveryRate)}
          sub={`${money(s.live.control.recoveredCents, { compact: true })} of ${money(s.live.control.atRiskCents, { compact: true })}, ${count(s.live.control.cases)} cases`}
        />
        <Tile
          label="Treatment arm"
          value={pct(s.live.treatment.recoveryRate)}
          sub={`${money(s.live.treatment.recoveredCents, { compact: true })} of ${money(s.live.treatment.atRiskCents, { compact: true })}, ${count(s.live.treatment.cases)} cases`}
        />
        <Tile
          label="Live uplift"
          value={points(s.live.upliftPoints)}
          sub={s.batch?.startedAt ? "treatment minus control" : "batch not started: no treatment work yet"}
        />
        <Tile
          label="Organic cases"
          value={count(s.organic.cases)}
          sub={`${money(s.organic.recoveredCents)} of ${money(s.organic.atRiskCents)} recovered`}
        />
      </div>
    </section>
  );
}
