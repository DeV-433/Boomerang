import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { SensitivityResponse, SpreadPoints } from "@boomerang/core";
import { api } from "./api";
import { count, dateTime, points } from "./format";

type Measure = "sameCases" | "vsControl";
const MEASURES: { id: Measure; label: string; hint: string }[] = [
  {
    id: "sameCases",
    label: "Same cases",
    hint: "Boomerang vs the fixed schedule on the very same cases: the strategy's own effect.",
  },
  {
    id: "vsControl",
    label: "vs control arm",
    hint: "Treatment arm vs control arm: also includes the luck of which cases landed in which arm.",
  },
];

const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;

/**
 * 9.2: the range of uplift across simulator variations and seeds. One row per variation: the bar
 * spans min to max, each dot is one seed, the tick is the median, the dashed line is zero.
 */
export function SensitivityCard({ className }: { className: string }) {
  const [measure, setMeasure] = useState<Measure>("sameCases");
  const q = useQuery({
    queryKey: ["sensitivity"],
    queryFn: ({ signal }) => api<SensitivityResponse>("/api/sensitivity", { signal }),
    refetchInterval: 60_000,
  });
  const sweep = q.data?.sweep;
  const header = (
    <div className="card-head">
      <h2>Uplift across seeds and settings</h2>
      <div className="tabs" role="tablist" aria-label="Uplift measure">
        {MEASURES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={measure === m.id}
            className={`tab${measure === m.id ? " active" : ""}`}
            title={m.hint}
            onClick={() => setMeasure(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
  if (q.isPending)
    return (
      <section className={`card ${className}`}>
        {header}
        <p className="muted">Loading the sensitivity sweep...</p>
      </section>
    );
  if (!sweep)
    return (
      <section className={`card ${className}`}>
        {header}
        <p className="muted">
          No sweep yet. Run <code>npm run sim:sensitivity</code> to vary the simulator's settings and seeds.
        </p>
      </section>
    );

  const valueOf = (c: (typeof sweep.cells)[number]) =>
    measure === "sameCases" ? c.upliftSameCases : c.upliftVsControl;
  const all = sweep.cells.map(valueOf);
  const lo = Math.floor(Math.min(0, ...all) / 5) * 5;
  const hi = Math.ceil(Math.max(0, ...all) / 5) * 5 || 5;
  const x = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / 10) * 10; t <= hi; t += 10) ticks.push(t);
  const overall: SpreadPoints = sweep.overall[measure];
  const rows = [
    { id: "__all", label: "All variations", spread: overall, values: all, strong: true },
    ...sweep.variations.map((v) => ({
      id: v.id,
      label: v.label,
      spread: v[measure],
      values: sweep.cells.filter((c) => c.variation === v.id).map(valueOf),
      strong: false,
    })),
  ];
  const afterOptOut = sweep.cells.reduce((s, c) => s + c.contactsAfterOptOut, 0);

  return (
    <section className={`card ${className}`} data-testid="sensitivity">
      {header}
      <div className="sens-head">
        <div>
          <div className="tile-label">Range of uplift</div>
          <div className="big-number sens-range">
            {signed(overall.min)} <span className="muted">to</span> {signed(overall.max)}
            <span className="accent big-number-unit">pts</span>
          </div>
          <p className="tile-sub">
            Median {points(overall.median)}; above zero in {Math.round(overall.positiveShare * 100)}% of{" "}
            {count(sweep.cells.length)} runs ({sweep.seeds.length} seeds × {sweep.variations.length}{" "}
            variations, {count(sweep.size)} cases each, {sweep.strategy}).{" "}
            {MEASURES.find((m) => m.id === measure)!.hint}
          </p>
        </div>
        <div className="tiles sens-tiles">
          <div className="tile">
            <div className="tile-label">Seeds</div>
            <div className="tile-value">{sweep.seeds.length}</div>
            <div className="tile-sub">{sweep.seeds.join(", ")}</div>
          </div>
          <div className="tile">
            <div className="tile-label">Contacts after opt-out</div>
            <div className="tile-value">{count(afterOptOut)}</div>
            <div className="tile-sub">across every run</div>
          </div>
        </div>
      </div>

      <div className="strip" role="group" aria-label="Uplift by variation, one dot per seed">
        {rows.map((r) => {
          const tip = `${r.label}: ${signed(r.spread.min)} to ${signed(r.spread.max)} points, median ${signed(r.spread.median)}`;
          return (
            <div className={`strip-row${r.strong ? " strip-strong" : ""}`} key={r.id}>
              <div className="strip-name">{r.label}</div>
              <div className="strip-track" tabIndex={0} title={tip} aria-label={tip}>
                <span className="ci-zero" style={{ left: `${x(0)}%` }} aria-hidden="true" />
                <span
                  className="strip-bar"
                  style={{
                    left: `${x(r.spread.min)}%`,
                    width: `${Math.max(0.5, x(r.spread.max) - x(r.spread.min))}%`,
                  }}
                  aria-hidden="true"
                />
                {!r.strong &&
                  r.values.map((v, i) => (
                    <span
                      key={i}
                      className="strip-dot"
                      style={{ left: `${x(v)}%` }}
                      title={`${r.label}, ${sweep.seeds[i] ?? ""}: ${signed(v)} points`}
                      aria-hidden="true"
                    />
                  ))}
                <span
                  className="strip-median"
                  style={{ left: `${x(r.spread.median)}%` }}
                  aria-hidden="true"
                />
              </div>
              <div className="strip-value">
                {signed(r.spread.min)} / <strong>{signed(r.spread.median)}</strong> / {signed(r.spread.max)}
              </div>
            </div>
          );
        })}
        <div className="strip-row strip-axis" aria-hidden="true">
          <div />
          <div className="ci-ticks">
            {ticks.map((t) => (
              <span key={t} style={{ left: `${x(t)}%` }}>
                {t > 0 ? `+${t}` : t < 0 ? `−${Math.abs(t)}` : "0"}
              </span>
            ))}
          </div>
          <div className="strip-key">min / median / max</div>
        </div>
      </div>

      <details className="table-view">
        <summary>Every run as a table</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Variation</th>
                <th scope="col">Seed</th>
                <th scope="col">Control</th>
                <th scope="col">Treatment</th>
                <th scope="col">Baseline, same cases</th>
                <th scope="col">Same cases</th>
                <th scope="col">vs control</th>
              </tr>
            </thead>
            <tbody>
              {sweep.cells.map((c) => (
                <tr key={`${c.variation}|${c.seed}`}>
                  <th scope="row">
                    {sweep.variations.find((v) => v.id === c.variation)?.label ?? c.variation}
                  </th>
                  <td>{c.seed}</td>
                  <td>{(c.controlRate * 100).toFixed(1)}%</td>
                  <td>{(c.treatmentRate * 100).toFixed(1)}%</td>
                  <td>{(c.baselineOnTreatmentRate * 100).toFixed(1)}%</td>
                  <td>{signed(c.upliftSameCases)}</td>
                  <td>{signed(c.upliftVsControl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="note">
        Swept {dateTime(sweep.createdAt)} from simulator config {sweep.configHash}. Each variation changes one
        group of assumptions for both arms; they were fixed before any result was seen.
      </p>
    </section>
  );
}
