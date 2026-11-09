import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type {
  SavedScenario,
  ScenarioReloadResponse,
  WhatIfDefaults,
  WhatIfInterval,
  WhatIfOverrides,
  WhatIfResponse,
} from "@boomerang/core";
import { api } from "../api";
import { count, dateTime, money, pct, points } from "../format";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Settings = Required<WhatIfOverrides>;

/** Only the settings that differ from the current policy are sent as overrides. */
function overridesFrom(s: Settings, d: WhatIfDefaults): WhatIfOverrides {
  const o: WhatIfOverrides = {};
  for (const k of Object.keys(d) as (keyof WhatIfDefaults)[]) {
    const changed =
      k === "contactDays"
        ? [...s.contactDays].sort().join() !== [...d.contactDays].sort().join()
        : s[k] !== d[k];
    if (changed) (o as Record<string, unknown>)[k] = s[k];
  }
  return o;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Slider(props: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  current: number;
  format: (n: number) => string;
  note?: string;
  onChange: (n: number) => void;
}) {
  const changed = props.value !== props.current;
  return (
    <div className={`slider${changed ? " changed" : ""}`}>
      <div className="slider-head">
        <label htmlFor={props.id}>{props.label}</label>
        <output htmlFor={props.id}>{props.format(props.value)}</output>
      </div>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <div className="slider-foot muted">
        now {props.format(props.current)}
        {props.note && <span> · {props.note}</span>}
      </div>
    </div>
  );
}

const ci = (i: WhatIfInterval, f: (n: number) => string) => `95% CI ${f(i.low)} to ${f(i.high)}`;
const signedMoney = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${money(Math.abs(cents))}`;
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`;

function Results({ r, stale }: { r: WhatIfResponse; stale: boolean }) {
  const { diff, interval } = r;
  const crossesZero = interval.recoveredCents.low <= 0 && interval.recoveredCents.high >= 0;
  const rows: [string, string, string, string, string?][] = [
    [
      "Recovered",
      money(diff.recoveredCents.base),
      money(diff.recoveredCents.scenario),
      signedMoney(diff.recoveredCents.delta),
      ci(interval.recoveredCents, signedMoney),
    ],
    [
      "Recovery rate",
      pct(diff.recoveryRate.base),
      pct(diff.recoveryRate.scenario),
      points(diff.recoveryRate.deltaPoints),
      ci(interval.recoveryRatePoints, (n) => points(n)),
    ],
    ["Contacts sent", count(diff.contacts.base), count(diff.contacts.scenario), signed(diff.contacts.delta)],
    [
      "Escalated to a person",
      count(diff.escalations.base),
      count(diff.escalations.scenario),
      signed(diff.escalations.delta),
    ],
    [
      "Contacts after opt-out",
      count(diff.contactsAfterOptOut.base),
      count(diff.contactsAfterOptOut.scenario),
      signed(diff.contactsAfterOptOut.delta),
    ],
    [
      "Disputes",
      count(r.base.disputes),
      count(r.scenario.disputes),
      signed(r.scenario.disputes - r.base.disputes),
    ],
    ...(r.overrides.payPage
      ? ([
          [
            "Used the pay page",
            count(r.base.payPageUses),
            count(r.scenario.payPageUses),
            signed(r.scenario.payPageUses - r.base.payPageUses),
          ],
          [
            "  paid on the page",
            count(r.base.payPagePayments),
            count(r.scenario.payPagePayments),
            signed(r.scenario.payPagePayments - r.base.payPagePayments),
          ],
          [
            "  promised on the page",
            count(r.base.payPagePromises),
            count(r.scenario.payPagePromises),
            signed(r.scenario.payPagePromises - r.base.payPagePromises),
          ],
        ] as [string, string, string, string][])
      : []),
  ];
  return (
    <section className={`card${stale ? " stale" : ""}`} aria-busy={stale}>
      <div className="tiles">
        <div className="tile tile-hero">
          <div className="tile-label">Change in recovered dollars</div>
          <div className="tile-value">{signedMoney(diff.recoveredCents.delta)}</div>
          <div className="tile-sub">
            {ci(interval.recoveredCents, signedMoney)}
            {Object.keys(r.overrides).length > 0 &&
              (crossesZero
                ? ". The interval includes zero: no clear effect."
                : diff.recoveredCents.delta > 0
                  ? ". A clear gain."
                  : ". A clear loss.")}
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Cases that changed</div>
          <div className="tile-value">{count(diff.casesChanged)}</div>
          <div className="tile-sub">
            {diff.casesNewlyRecovered} newly recovered, {diff.casesNoLongerRecovered} no longer recovered
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Replayed</div>
          <div className="tile-value">{count(r.batch.cases)} cases</div>
          <div className="tile-sub">
            {r.batch.name}, {r.elapsedMs} ms
          </div>
        </div>
      </div>
      <table className="whatif-table">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">Current policy</th>
            <th scope="col">With your changes</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, a, b, d, interval]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{a}</td>
              <td>{b}</td>
              <td>
                {d}
                {interval && <div className="muted small">{interval}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">
        Replays this batch's {count(r.batch.cases)} cases through Boomerang's real diagnosis, rules and policy
        gate against simulated customers. Nothing is sent and nothing is saved unless you save a scenario.
        Intervals: paired bootstrap, {interval.recoveredCents.iterations.toLocaleString()} resamples.
      </p>
    </section>
  );
}

export function WhatIf() {
  const queryClient = useQueryClient();
  const defaults = useQuery({
    queryKey: ["whatif-defaults"],
    queryFn: ({ signal }) => api<WhatIfDefaults>("/api/whatif/defaults", { signal }),
    staleTime: Infinity,
  });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [name, setName] = useState("");
  const [reloadCheck, setReloadCheck] = useState<{ name: string; same: boolean } | null>(null);

  useEffect(() => {
    if (defaults.data && !settings) setSettings({ ...defaults.data });
  }, [defaults.data, settings]);

  const overrides = useMemo(
    () => (settings && defaults.data ? overridesFrom(settings, defaults.data) : null),
    [settings, defaults.data],
  );
  const debounced = useDebounced(overrides, 350);
  const result = useQuery({
    queryKey: ["whatif", debounced],
    queryFn: ({ signal }) =>
      api<WhatIfResponse>("/api/whatif", { method: "POST", body: { overrides: debounced }, signal }),
    enabled: debounced !== null,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
  const saved = useQuery({
    queryKey: ["scenarios"],
    queryFn: ({ signal }) => api<{ rows: SavedScenario[] }>("/api/scenarios", { signal }),
  });
  const save = useMutation({
    mutationFn: () =>
      api<SavedScenario>("/api/scenarios", { method: "POST", body: { name: name.trim(), overrides } }),
    onSuccess: () => {
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["scenarios"] });
    },
  });

  async function load(s: SavedScenario) {
    if (!defaults.data) return;
    setSettings({ ...defaults.data, ...s.overrides });
    const r = await api<ScenarioReloadResponse>(`/api/scenarios/${s.id}/reload`);
    queryClient.setQueryData(
      ["whatif", overridesFrom({ ...defaults.data, ...s.overrides }, defaults.data)],
      r.result,
    );
    setReloadCheck({ name: s.name, same: r.sameResult });
  }

  if (defaults.isError)
    return <p className="error">Could not load the current policy: {defaults.error.message}</p>;
  if (!settings || !defaults.data) return <p className="muted">Loading the current policy...</p>;
  const d = defaults.data;
  const set = (patch: Partial<Settings>) => {
    setReloadCheck(null);
    setSettings({ ...settings, ...patch });
  };

  return (
    <div className="whatif-page">
      <div className="page-head">
        <h1>What-if</h1>
        <span className="muted">Change the policy and see what would have happened to this batch.</span>
      </div>
      <div className="whatif-layout">
        <section className="card controls" aria-label="Policy settings">
          <div className="card-head">
            <h2>Policy</h2>
            <button
              className="link-button"
              onClick={() => set({ ...d })}
              disabled={Object.keys(overrides ?? {}).length === 0}
            >
              Reset
            </button>
          </div>
          <Slider
            id="perCase"
            label="Contacts per case"
            value={settings.perCase}
            min={1}
            max={6}
            step={1}
            current={d.perCase}
            format={String}
            note={
              settings.perCase > 3
                ? "above 3 has no effect: the rules escalate after 3 tone stages"
                : undefined
            }
            onChange={(v) => set({ perCase: v })}
          />
          <Slider
            id="perWeek"
            label="Contacts per customer per week"
            value={settings.perCustomerPerWeek}
            min={1}
            max={7}
            step={1}
            current={d.perCustomerPerWeek}
            format={String}
            onChange={(v) => set({ perCustomerPerWeek: v })}
          />
          <Slider
            id="gap"
            label="Minimum gap between contacts"
            value={settings.minGapHours}
            min={12}
            max={168}
            step={12}
            current={d.minGapHours}
            format={(n) => `${n} h`}
            onChange={(v) => set({ minGapHours: v })}
          />
          <Slider
            id="approval"
            label="Approval needed above"
            value={settings.approvalAmountCents}
            min={0}
            max={1_000_000}
            step={10_000}
            current={d.approvalAmountCents}
            format={(n) => money(n, { compact: true })}
            onChange={(v) => set({ approvalAmountCents: v })}
          />
          <Slider
            id="floor"
            label="Confidence floor"
            value={settings.confidenceFloor}
            min={0}
            max={1}
            step={0.05}
            current={d.confidenceFloor}
            format={(n) => n.toFixed(2)}
            onChange={(v) => set({ confidenceFloor: v })}
          />
          <Slider
            id="start"
            label="Contact window opens"
            value={settings.hoursStart}
            min={6}
            max={Math.min(12, settings.hoursEnd - 1)}
            step={1}
            current={d.hoursStart}
            format={(n) => `${n}:00`}
            onChange={(v) => set({ hoursStart: v })}
          />
          <Slider
            id="end"
            label="Contact window closes"
            value={settings.hoursEnd}
            min={Math.max(15, settings.hoursStart + 1)}
            max={22}
            step={1}
            current={d.hoursEnd}
            format={(n) => `${n}:00`}
            onChange={(v) => set({ hoursEnd: v })}
          />
          <fieldset className="days">
            <legend>Contact days</legend>
            {DAYS.map((label, i) => (
              <label key={label} className="check">
                <input
                  type="checkbox"
                  checked={settings.contactDays.includes(i)}
                  disabled={settings.contactDays.length === 1 && settings.contactDays.includes(i)}
                  onChange={(e) =>
                    set({
                      contactDays: e.target.checked
                        ? [...settings.contactDays, i].sort()
                        : settings.contactDays.filter((x) => x !== i),
                    })
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <label className="check toggle">
            <input
              type="checkbox"
              checked={settings.payPage}
              onChange={(e) => set({ payPage: e.target.checked })}
            />
            Reminders carry the self-serve pay page
          </label>
          {settings.payPage && (
            <p className="small muted">
              Assumed use rates by customer type are in the simulator config (sim/config/simulator.json,
              payPage).
            </p>
          )}

          <div className="save">
            <h3>Save this scenario</h3>
            <div className="save-row">
              <input
                aria-label="Scenario name"
                placeholder="Name, for example: two contacts max"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
              />
              <button
                className="primary"
                disabled={!name.trim() || save.isPending}
                onClick={() => save.mutate()}
              >
                Save
              </button>
            </div>
            {save.isError && <p className="error small">{save.error.message}</p>}
          </div>
          {saved.data && saved.data.rows.length > 0 && (
            <div className="saved">
              <h3>Saved scenarios</h3>
              <ul>
                {saved.data.rows.map((s) => (
                  <li key={s.id}>
                    <button className="link-button" onClick={() => void load(s)}>
                      {s.name}
                    </button>
                    <span className="muted small">
                      {" "}
                      {signedMoney(s.result.diff.recoveredCents.delta)} · {dateTime(s.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <div className="whatif-results">
          {reloadCheck && (
            <p className={reloadCheck.same ? "flash" : "flash flash-bad"} role="status">
              "{reloadCheck.name}" reloaded:{" "}
              {reloadCheck.same
                ? "same result as when it was saved."
                : "the result differs from when it was saved (the batch or the code has changed since)."}
            </p>
          )}
          {result.isError && <p className="error">What-if failed: {result.error.message}</p>}
          {result.data ? (
            <Results r={result.data} stale={result.isFetching || debounced !== overrides} />
          ) : (
            <p className="muted">Replaying the batch...</p>
          )}
        </div>
      </div>
    </div>
  );
}
