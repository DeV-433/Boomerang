import { useQuery } from "@tanstack/react-query";
import type { ViolationsResponse } from "@boomerang/core";
import { api } from "./api";
import { count, dateTime } from "./format";

/** 9.4: actions that broke any policy rule, across every Boomerang run and executed action. */
export function ViolationsCard({ className }: { className: string }) {
  const q = useQuery({
    queryKey: ["violations"],
    queryFn: ({ signal }) => api<ViolationsResponse>("/api/violations", { signal }),
    refetchInterval: 60_000,
  });
  const r = q.data;
  return (
    <section className={`card card-accent ${className}`} data-testid="violations">
      <h2>Rule violations</h2>
      {q.isPending && <p className="muted">Checking...</p>}
      {q.isError && <p className="error">Could not run the check: {q.error.message}</p>}
      {r && (
        <>
          <div className="hero-line">
            <span className={`big-number ${r.total === 0 ? "" : "error"}`}>{count(r.total)}</span>
            <span className={`delta ${r.total === 0 ? "delta-up" : "delta-down"}`}>
              {r.total === 0 ? "none found" : "needs fixing"}
            </span>
          </div>
          <p className="tile-sub">
            Every contact re-checked against the policy rules, independently of the gate: opt-out, dispute,
            already resolved, per-case and per-customer caps, 48-hour spacing, contact hours, approval for
            money-moving actions.
          </p>
          <dl className="settings-list">
            <div>
              <dt>Simulated</dt>
              <dd>
                {count(r.simulated.contacts)} contacts in {count(r.simulated.runs)} Boomerang runs (
                {count(r.simulated.cases)} cases): {count(r.simulated.violations.length)} violations
              </dd>
            </div>
            <div>
              <dt>Live and dry run</dt>
              <dd>
                {count(r.live.actions)} executed actions, {count(r.live.contacts)} contacts:{" "}
                {count(r.live.violations.length)} violations
              </dd>
            </div>
          </dl>
          {r.total > 0 && (
            <ul className="violations-list">
              {[...r.live.violations, ...r.simulated.violations].slice(0, 8).map((v, i) => (
                <li key={i}>
                  <strong>
                    Rule {v.rule} {v.name}
                  </strong>{" "}
                  <span className="muted">{v.detail}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="note">
            Checked {dateTime(r.checkedAt)}. Baseline runs are not checked: they ignore replies by design.
          </p>
        </>
      )}
    </section>
  );
}
