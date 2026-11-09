import { useQuery } from "@tanstack/react-query";
import { NavLink, Route, Routes } from "react-router-dom";
import { api, API_URL, setToken, type Health } from "./api";
import { useToken } from "./auth";
import { Placeholder } from "./pages/Placeholder";
import { SignIn } from "./pages/SignIn";
import { Approvals } from "./pages/Approvals";
import { Audit } from "./pages/Audit";
import { Cases } from "./pages/Cases";
import { Summary } from "./pages/Summary";
import { WhatIf } from "./pages/WhatIf";
import { PauseButton, PausedBanner } from "./SystemControl";

const NAV = [
  { to: "/", label: "Summary" },
  { to: "/cases", label: "Cases" },
  { to: "/approvals", label: "Approvals" },
  { to: "/audit", label: "Audit" },
  { to: "/whatif", label: "What-if" },
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
      {label}
    </span>
  );
}

export function App() {
  const token = useToken();
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Boomerang</span>
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <HealthBadge />
        {token && <PauseButton />}
        {token && (
          <button className="link-button" onClick={() => setToken(null)}>
            Sign out
          </button>
        )}
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
            <Route path="*" element={<Placeholder title="Not found" />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
