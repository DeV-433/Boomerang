import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api, API_URL, setToken, type Health } from "./api";
import { useToken } from "./auth";
import { Placeholder } from "./pages/Placeholder";
import { SignIn } from "./pages/SignIn";
import { Approvals } from "./pages/Approvals";
import { Audit } from "./pages/Audit";
import { Cases } from "./pages/Cases";
import { Summary } from "./pages/Summary";
import { Trust } from "./pages/Trust";
import { WhatIf } from "./pages/WhatIf";
import { PauseButton, PausedBanner } from "./SystemControl";

// The scheduler is large: load it only when the Timeline page opens.
const Timeline = lazy(() => import("./pages/Timeline").then((m) => ({ default: m.Timeline })));

const NAV = [
  { to: "/", label: "Summary" },
  { to: "/cases", label: "Cases" },
  { to: "/approvals", label: "Approvals" },
  { to: "/audit", label: "Audit" },
  { to: "/whatif", label: "What-if" },
  { to: "/trust", label: "Trust" },
  { to: "/timeline", label: "Timeline" },
];

function HealthBadge() {
  const health = useQuery({
    queryKey: ["healthz"],
    queryFn: ({ signal }) => api<Health>("/healthz", { signal }),
    refetchInterval: 30_000,
  });
  const ok = health.data?.status === "ok";
  const label = health.isPending ? "Checking API" : ok ? "API healthy" : "API unreachable";
  return (
    <span
      className={`badge ${health.isPending ? "" : ok ? "badge-ok" : "badge-bad"}`}
      title={API_URL}
      data-testid="health"
    >
      <span className="dot" aria-hidden="true" />
      <span className="badge-label">{label}</span>
    </span>
  );
}

export function App() {
  const token = useToken();
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M5 19c3-1 6-4 7.5-8.5L14 5l5 2-3.5 3.5C13 14 9 17.5 5 19Z" fill="currentColor" />
            </svg>
          </span>
          Boomerang
        </span>
        <nav className="nav" aria-label="Pages">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="top-actions">
          <HealthBadge />
          {token && <PauseButton />}
          {token && (
            <button className="link-button" onClick={() => setToken(null)}>
              Sign out
            </button>
          )}
        </div>
      </header>
      {token && <PausedBanner />}
      <main className="content">
        {!token ? (
          <SignIn />
        ) : (
          <Routes>
            <Route path="/" element={<Summary />} />
            <Route path="/cases" element={<Cases />} />
            <Route path="/approvals" element={<Approvals />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/whatif" element={<WhatIf />} />
            <Route path="/trust" element={<Trust />} />
            <Route
              path="/timeline"
              element={
                <Suspense fallback={<p className="muted">Loading the timeline...</p>}>
                  <Timeline />
                </Suspense>
              }
            />
            <Route path="*" element={<Placeholder title="Not found" />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
