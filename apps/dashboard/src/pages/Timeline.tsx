import "@bryntum/core-enterprise/fontawesome/css/fontawesome.css";
import "@bryntum/core-enterprise/fontawesome/css/solid.css";
import "@bryntum/scheduler-enterprise/scheduler.css";
import "@bryntum/scheduler-enterprise/svalbard.css";
import { BryntumScheduler, type BryntumSchedulerProps } from "@bryntum/scheduler-react-enterprise";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { TimelineEvent, TimelineEventKind, TimelineResponse } from "@boomerang/core";
import { api } from "../api";
import { count, money } from "../format";
import { KIND_META, ruleText, whenText } from "../timelineKinds";

const PAGE = 30;
const HOUR = 3_600_000;

type Source = { kind: "run"; run: string } | { kind: "live"; batch: "organic" | "all" };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const human = (s: string) => s.replace(/_/g, " ");

interface EventData {
  id: string;
  resourceId: string;
  name: string;
  startDate: Date;
  endDate: Date;
  eventColor: string;
  eventStyle: string;
  cls: string;
  source: TimelineEvent;
}

/**
 * A point in time gets a short bar so it can be seen and hovered at day zoom: a quarter of a day
 * for live data, and the whole day for a simulated run (which only knows the day).
 */
function toEvent(e: TimelineEvent, simulated: boolean): EventData {
  const start = new Date(e.start);
  const end = e.end ? new Date(e.end) : new Date(start.getTime() + (simulated ? 20 : 6) * HOUR);
  const meta = KIND_META[e.kind];
  return {
    id: e.id,
    resourceId: e.caseId,
    name: meta.label,
    startDate: start,
    endDate: end,
    eventColor: meta.bryntumColor,
    eventStyle: e.future ? "outlined" : "filled",
    cls: `tl-${e.kind}`,
    source: e,
  };
}

function tooltip(e: TimelineEvent, simulated: boolean): string {
  const rule = ruleText(e);
  return [
    `<div class="tl-tip"><strong>${esc(e.label)}</strong>`,
    `<div class="tl-tip-when">${esc(whenText(e, simulated))}</div>`,
    rule ? `<div class="tl-tip-rule">${esc(rule)}</div>` : "",
    e.detail ? `<div class="tl-tip-detail">${esc(e.detail)}</div>` : "",
    "</div>",
  ].join("");
}

function Legend() {
  return (
    <ul className="tl-legend" aria-label="Legend">
      {(Object.keys(KIND_META) as TimelineEventKind[])
        .filter((k) => k !== "opened")
        .map((k) => (
          <li key={k}>
            <i
              className={`fa ${KIND_META[k].icon}`}
              style={{ color: `var(${KIND_META[k].cssVar})` }}
              aria-hidden
            />
            {KIND_META[k].label}
          </li>
        ))}
      <li>
        <span className="tl-dashed" aria-hidden /> Still to come
      </li>
    </ul>
  );
}

/**
 * Step 8.2: the recovery timeline. One row per case, every contact, promise, PayPal event and
 * scheduled check on a shared time axis, and the marker that ended the case. Read-only.
 */
export function Timeline() {
  const [source, setSource] = useState<Source>({ kind: "run", run: "latest" });
  const [offset, setOffset] = useState(0);

  const path =
    source.kind === "run"
      ? `/api/timeline?source=run&run=${source.run}&limit=${PAGE}&offset=${offset}`
      : `/api/timeline?source=live${source.batch === "organic" ? "&batch=organic" : ""}&limit=${PAGE}&offset=${offset}`;
  const q = useQuery({
    queryKey: ["timeline", path],
    queryFn: ({ signal }) => api<TimelineResponse>(path, { signal }),
    placeholderData: keepPreviousData,
  });
  const data = q.data;
  const simulated = data?.source === "run";

  const props = useMemo<BryntumSchedulerProps | null>(() => {
    if (!data) return null;
    return {
      startDate: new Date(data.range.start),
      endDate: new Date(data.range.end),
      viewPreset: "weekAndDayLetter",
      rowHeight: 36,
      barMargin: 4,
      // Same-day events share the row instead of growing it.
      eventLayout: "pack",
      readOnly: true,
      eventStyle: "filled",
      columns: [
        { text: "Case", field: "name", width: 200 },
        { text: "Amount", field: "amount", width: 96, align: "end" },
        { text: simulated ? "Outcome" : "State", field: "state", width: 104 },
      ],
      resources: data.rows.map((r) => ({
        id: r.caseId,
        name: r.paypalRef,
        amount: money(r.amountCents),
        state: human(r.state),
      })),
      // Plain event configs; the extra `source` field rides along on each record for the tooltip.
      // "Case opened" is where each row starts anyway, so it is left off the chart to save space.
      events: data.events
        .filter((e) => e.kind !== "opened")
        .map((e) => toEvent(e, simulated)) as unknown as BryntumSchedulerProps["events"],
      // The bar shows only its icon; the hover card carries the words.
      eventRenderer: ({ eventRecord, renderData }) => {
        renderData.ariaLabel = eventRecord.name;
        return {
          tag: "i",
          className: `fa ${KIND_META[(eventRecord.getData("source") as TimelineEvent).kind].icon}`,
        };
      },
      eventTooltipFeature: {
        template: ({ eventRecord }) => tooltip(eventRecord.getData("source") as TimelineEvent, simulated),
      },
      timeRangesFeature: simulated ? false : { showCurrentTimeLine: { name: "Now" } },
      eventMenuFeature: false,
      scheduleMenuFeature: false,
      cellMenuFeature: false,
      eventEditFeature: false,
      eventDragCreateFeature: false,
      eventDragFeature: false,
      eventResizeFeature: false,
      cellEditFeature: false,
      scheduleTooltipFeature: false,
    };
  }, [data, simulated]);

  const total = data?.total ?? 0;
  const runLabel = (r: TimelineResponse["runs"][number]) =>
    `${r.strategy} (${r.arm}, ${new Date(r.startedAt).toLocaleDateString()}, ${r.cases} cases)`;

  return (
    <div className="timeline-page">
      <div className="page-head">
        <h1>Timeline</h1>
        <span className="muted">
          Every case on one time axis: what was sent, what was promised, and how it ended.
        </span>
      </div>
      <div className="toolbar">
        <label className="small muted" htmlFor="tl-source">
          Show
        </label>
        <select
          id="tl-source"
          value={source.kind === "run" ? `run:${source.run}` : `live:${source.batch}`}
          onChange={(e) => {
            const [kind, value] = e.target.value.split(":") as [string, string];
            setOffset(0);
            setSource(
              kind === "run"
                ? { kind: "run", run: value }
                : { kind: "live", batch: value as "organic" | "all" },
            );
          }}
        >
          <optgroup label="Simulated run (seeded batch)">
            <option value="run:latest">Latest Boomerang run</option>
            {data?.runs.map((r) => (
              <option key={r.id} value={`run:${r.id}`}>
                {runLabel(r)}
              </option>
            ))}
          </optgroup>
          <optgroup label="Live cases">
            <option value="live:organic">Organic sandbox cases</option>
            <option value="live:all">All live cases, newest first</option>
          </optgroup>
        </select>
        <span className="spacer" />
        <span className="small muted">
          {total ? `${count(offset + 1)}–${count(Math.min(offset + PAGE, total))} of ${count(total)}` : ""}
        </span>
        <button disabled={offset === 0 || q.isFetching} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          Previous
        </button>
        <button disabled={offset + PAGE >= total || q.isFetching} onClick={() => setOffset(offset + PAGE)}>
          Next
        </button>
      </div>
      <Legend />
      {q.isError && <p className="error">{q.error.message}</p>}
      {data && simulated && data.run && (
        <p className="small muted">
          Run {runLabel(data.run)}. Days are on the simulator's clock; a simulated run records the day of each
          event, not the hour, and has no scheduled checks.
        </p>
      )}
      {data && data.rows.length === 0 && <p className="muted">No cases here.</p>}
      {props && data && data.rows.length > 0 && (
        <div className="tl-host" style={{ height: Math.min(780, 90 + data.rows.length * 40) }}>
          {/* Features are read at creation: a new source (with or without the "now" line) is a new scheduler. */}
          <BryntumScheduler key={data.source} {...props} />
        </div>
      )}
    </div>
  );
}
