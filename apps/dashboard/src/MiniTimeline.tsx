import { useQuery } from "@tanstack/react-query";
import type { TimelineEvent, TimelineResponse } from "@boomerang/core";
import { api } from "./api";
import { KIND_META, ruleText, whenText } from "./timelineKinds";

/** A short glyph per kind, so a marker is never told apart by colour alone. */
const GLYPH: Record<TimelineEvent["kind"], string> = {
  opened: "O",
  contact: "M",
  followup: "C",
  promise: "P",
  paypal: "$",
  page: "L",
  recovered: "✓",
  stopped: "×",
  escalated: "H",
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * Step 8.4: the fallback timeline, plain HTML and CSS with no Bryntum, shown inside the audit
 * screen's detail row. One line for the case, a marker per event placed by time, a hover title
 * with the details (and the gate rule for a stop), and the same events as a list for screen readers.
 */
export function MiniTimeline({ caseId }: { caseId: string }) {
  const q = useQuery({
    queryKey: ["mini-timeline", caseId],
    queryFn: ({ signal }) => api<TimelineResponse>(`/api/timeline?case=${caseId}`, { signal }),
  });
  if (q.isPending) return <div className="mini-tl muted small">Loading the timeline...</div>;
  if (q.isError) return <div className="mini-tl error small">Timeline unavailable: {q.error.message}</div>;
  const t = q.data;
  const events = t.events;
  if (!events.length) return null;

  // Span from the first event to the later of the last event and now, with a little room either side.
  const times = events.flatMap((e) => [Date.parse(e.start), e.end ? Date.parse(e.end) : Date.parse(e.start)]);
  const now = Date.parse(t.now);
  const lo = Math.min(...times);
  const hi = Math.max(...times, now);
  const pad = Math.max((hi - lo) * 0.04, 3_600_000);
  const from = lo - pad;
  const span = hi + pad - from;
  const frac = (ms: number) => (ms - from) / span;
  const pos = (ms: number) => `${(frac(ms) * 100).toFixed(2)}%`;
  // Markers closer than ~3% of the width would cover each other: put them on the next lane down.
  const GAP = 0.03;
  const laneEnds: number[] = [];
  const placed = [...events]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((e) => {
      const f = frac(Date.parse(e.start));
      let lane = laneEnds.findIndex((end) => f - end >= GAP);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = f;
      return { e, lane };
    });
  const lanes = Math.max(1, laneEnds.length);

  return (
    <div className="mini-tl" data-testid="mini-timeline">
      <div className="mini-tl-track" aria-hidden="true" style={{ height: 6 + lanes * 24 }}>
        <div className="mini-tl-line" />
        <div className="mini-tl-now" style={{ left: pos(now) }} title="Now" />
        {placed.map(({ e, lane }) => {
          const m = KIND_META[e.kind];
          const title = [e.label, whenText(e, false), ruleText(e), e.detail].filter(Boolean).join("\n");
          return (
            <span
              key={e.id}
              className={`mini-tl-mark${e.future ? " future" : ""}`}
              style={{
                left: pos(Date.parse(e.start)),
                top: 15 + lane * 24,
                ["--c" as string]: `var(${m.cssVar})`,
              }}
              title={title}
              data-kind={e.kind}
            >
              {GLYPH[e.kind]}
            </span>
          );
        })}
      </div>
      <div className="mini-tl-axis small muted" aria-hidden="true">
        <span>{day(new Date(from).toISOString())}</span>
        <span>{day(new Date(from + span).toISOString())}</span>
      </div>
      <ul className="sr-only">
        {events.map((e) => (
          <li key={e.id}>
            {[e.label, whenText(e, false), ruleText(e), e.detail].filter(Boolean).join(". ")}
          </li>
        ))}
      </ul>
      <div className="mini-tl-key small muted" aria-hidden="true">
        {[...new Set(events.map((e) => e.kind))].map((k) => (
          <span key={k}>
            <b style={{ color: `var(${KIND_META[k].cssVar})` }}>{GLYPH[k]}</b> {KIND_META[k].label}
          </span>
        ))}
        <span>Hover a marker for details.</span>
      </div>
    </div>
  );
}
