import { points } from "./format";

export interface IntervalRow {
  name: string;
  /** Percentage points. */
  estimate: number;
  low: number;
  high: number;
  /** Extra hover text. */
  note?: string;
}

/** Rounds the domain out to a multiple of 10 points and always includes zero. */
function domainOf(rows: IntervalRow[]): [number, number] {
  const lo = Math.min(0, ...rows.map((r) => r.low));
  const hi = Math.max(0, ...rows.map((r) => r.high));
  return [Math.floor(lo / 10) * 10, Math.ceil(hi / 10) * 10 || 10];
}

/**
 * 9.1: a small forest plot. One row per comparison: the bar is the 95% interval, the dot is the
 * estimate, the dashed line is zero (no effect). One series, so no legend; the rows are labelled
 * and every value is printed beside its row.
 */
export function IntervalPlot({ rows, level = 0.95 }: { rows: IntervalRow[]; level?: number }) {
  if (rows.length === 0) return null;
  const [min, max] = domainOf(rows);
  const x = (v: number) => ((v - min) / (max - min)) * 100;
  const ticks = [min, ...(min < 0 && max > 0 ? [0] : []), max];
  return (
    <div className="ci" role="group" aria-label={`Uplift with ${Math.round(level * 100)}% intervals`}>
      {rows.map((r) => {
        const tip = `${r.name}: ${points(r.estimate)}, ${Math.round(level * 100)}% interval ${points(r.low)} to ${points(r.high)}${r.note ? `. ${r.note}` : ""}`;
        return (
          <div className="ci-row" key={r.name}>
            <div className="ci-name">{r.name}</div>
            <div className="ci-track" tabIndex={0} title={tip} aria-label={tip}>
              <span className="ci-zero" style={{ left: `${x(0)}%` }} aria-hidden="true" />
              <span
                className="ci-bar"
                style={{ left: `${x(r.low)}%`, width: `${Math.max(0.5, x(r.high) - x(r.low))}%` }}
                aria-hidden="true"
              />
              <span className="ci-dot" style={{ left: `${x(r.estimate)}%` }} aria-hidden="true" />
            </div>
            <div className="ci-value">
              <strong>{points(r.estimate)}</strong>{" "}
              <span className="muted">
                {r.low.toFixed(1)} to {r.high.toFixed(1)}
              </span>
            </div>
          </div>
        );
      })}
      <div className="ci-row ci-axis" aria-hidden="true">
        <div className="ci-ticks">
          {ticks.map((t) => (
            <span key={t} style={{ left: `${x(t)}%` }}>
              {t > 0 ? `+${t}` : t < 0 ? `−${Math.abs(t)}` : "0"}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
