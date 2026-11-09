import { useQuery } from "@tanstack/react-query";
import { NavLink, Route, Routes } from "react-router-dom";
import { api, API_URL, type Health } from "./api";
import { Placeholder } from "./pages/Placeholder";

const NAV = [
  { to: "/", label: "Summary" },
  { to: "/cases", label: "Cases" },
  { to: "/approvals", label: "Approvals" },
  { to: "/audit", label: "Audit" },
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
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<Placeholder title="Summary" step="6.3" />} />
          <Route path="/cases" element={<Placeholder title="Cases" step="6.5" />} />
          <Route path="/approvals" element={<Placeholder title="Approvals" step="6.10" />} />
          <Route path="/audit" element={<Placeholder title="Audit" step="6.8" />} />
          <Route path="*" element={<Placeholder title="Not found" />} />
        </Routes>
      </main>
    </div>
  );
}
