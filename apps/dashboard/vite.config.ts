import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// VITE_API_URL is the API's public URL, baked in at build time (Render sets it for the static site).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { sourcemap: true },
});
