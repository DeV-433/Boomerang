import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ArmTotals, SimArmMetrics, SummaryResponse } from "@boomerang/core";
import { api } from "../api";
import { count, dateTime, money, pct, points, usd } from "../format";

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

  return (
    <div className="summary">
      <div className="page-head">
        <h1>Summary</h1>
        <div className="chips">
          <span className="chip">{s.batch ? s.batch.name : "no batch"}</span>
          <span className="chip">{s.system.mode === "live" ? "Live mode" : "Dry run"}</span>
          {s.system.paused && <span className="chip chip-warn">Paused</span>}
          <span className="chip">
            {s.batch?.startedAt ? `Batch started ${dateTime(s.batch.startedAt)}` : "Batch not started"}
          </span>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Simulated result: treatment vs control</h2>
          {sim.runs.some((r) => r.arm === "treatment") && (
            <label className="picker">
              Treatment run{" "}
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
        {ctl && trt ? (
          <>
            <div className="tiles">
              <Tile
                hero
                label="Uplift vs control"
                value={points(sim.upliftPoints)}
                sub={`${pct(trt.recoveryRate)} treatment vs ${pct(ctl.recoveryRate)} control`}
              />
              <Tile
                label="Recovered (treatment)"
                value={money(trt.recoveredCents, { compact: true })}
                sub={`of ${money(trt.atRiskCents, { compact: true })} at risk`}
              />
              <Tile
                label="Contacts sent"
                value={count(trt.contacts)}
                sub={`control sent ${count(ctl.contacts)}`}
              />
              <Tile
                label="Contacts after opt-out"
                value={count(trt.contactsAfterOptOut)}
                sub={`control: ${count(ctl.contactsAfterOptOut)}`}
              />
              {trt.modelCostPerRecoveredDollar !== undefined && (
                <Tile
                  label="Model cost per recovered dollar"
                  value={usd(trt.modelCostPerRecoveredDollar, 6)}
                  sub={trt.model ? `${usd(trt.model.all.costUsd)} for the run` : undefined}
                />
              )}
            </div>
            <h3>Recovery rate</h3>
            <RecoveryMeters
              rows={[
                { name: `Control (${sim.control!.strategy})`, totals: ctl },
                { name: `Treatment (${sim.treatment!.strategy})`, totals: trt },
              ]}
            />
            <details className="table-view" open>
              <summary>All metrics</summary>
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
                </tbody>
              </table>
            </details>
            <p className="note">
              Simulated customers: this reflects the simulator's assumptions, not real-world proof.
            </p>
          </>
        ) : (
          <p className="muted">No finished simulation runs for this batch yet.</p>
        )}
      </section>

      <section className="card">
        <h2>Live cases in the database</h2>
        <div className="tiles">
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
    </div>
  );
}
