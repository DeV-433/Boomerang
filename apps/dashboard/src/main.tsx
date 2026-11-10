import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles.css";

// Bryntum reads its licence from this global, set once at startup (before or after the scheduler loads).
const bryntumKey = import.meta.env.VITE_BRYNTUM_LICENSE_KEY as string | undefined;
if (bryntumKey) {
  const g = globalThis as { bryntum?: { licenseKey?: string } };
  (g.bryntum ??= {}).licenseKey = bryntumKey;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 5_000 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
