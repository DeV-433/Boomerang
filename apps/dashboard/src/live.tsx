import type { GridApi } from "ag-grid-community";
import { useEffect, useState, type RefObject } from "react";

export const LIVE_INTERVAL_MS = 15_000;

/**
 * Step 6.12: live updates by polling. Every LIVE_INTERVAL_MS while the tab is visible, the grid
 * re-asks the API for the blocks it shows (purge: false keeps scroll position and open groups),
 * so new and changed cases appear without a reload. Returns when the last refresh was asked for.
 */
export function useLiveGrid<T>(api: RefObject<GridApi<T> | null>, enabled = true): Date | null {
  const [last, setLast] = useState<Date | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState !== "visible" || !api.current) return;
      api.current.refreshServerSide({ purge: false });
      setLast(new Date());
    };
    const timer = setInterval(tick, LIVE_INTERVAL_MS);
    const onVisible = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [api, enabled]);
  return last;
}

export function LiveBadge({ last }: { last: Date | null }) {
  return (
    <span
      className="live"
      title={`Refreshes every ${LIVE_INTERVAL_MS / 1000} seconds while this tab is open`}
    >
      <span className="live-dot" aria-hidden="true" />
      Live{last ? `, updated ${last.toLocaleTimeString()}` : ""}
    </span>
  );
}
