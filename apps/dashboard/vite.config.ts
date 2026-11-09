import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// VITE_API_URL is the API's public URL, baked in at build time (Render sets it for the static site).
export default defineConfig({
  // Read VITE_* variables from the repo-root .env. Only VITE_-prefixed values reach the bundle.
  envDir: "../..",
  plugins: [react()],
  server: { port: 5173 },
  build: { sourcemap: true },
});
