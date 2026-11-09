import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SystemStatus } from "@boomerang/core";
import { api } from "./api";
import { dateTime } from "./format";

const useSystem = () =>
  useQuery({
    queryKey: ["system"],
    queryFn: ({ signal }) => api<SystemStatus>("/api/system", { signal }),
    refetchInterval: 10_000,
  });

/** Step 6.11: the global pause. Pausing blocks every new action at the next check, including approved ones. */
export function PauseButton() {
  const system = useSystem();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (paused: boolean) =>
      api<SystemStatus>("/api/system/pause", { method: "POST", body: { paused } }),
    onSuccess: (s) => {
      queryClient.setQueryData(["system"], s);
      void queryClient.invalidateQueries({ queryKey: ["summary"] });
    },
    onError: (err) => window.alert(`Could not change the pause: ${(err as Error).message}`),
  });
  if (!system.data) return null;
  const paused = system.data.paused;
  return (
    <button
      className={paused ? "pause-button resume" : "pause-button"}
      disabled={toggle.isPending}
      onClick={() => {
        if (
          !paused &&
          !window.confirm("Pause all activity? Boomerang will send nothing, to anyone, until you resume.")
        )
          return;
        toggle.mutate(!paused);
      }}
    >
      {paused ? "Resume all" : "Pause all"}
    </button>
  );
}

export function PausedBanner() {
  const system = useSystem();
  if (!system.data?.paused) return null;
  return (
    <div className="paused-banner" role="alert">
      <strong>All activity is paused.</strong> Nothing will be sent until you resume. Paused by{" "}
      {system.data.pausedBy ?? "the operator"}
      {system.data.changedAt ? ` on ${dateTime(system.data.changedAt)}` : ""}.
    </div>
  );
}
