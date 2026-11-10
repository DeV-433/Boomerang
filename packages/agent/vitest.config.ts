import { defineConfig } from "vitest/config";

// Database-backed tests share global state (pending events, the audit chain): run files one at a time.
export default defineConfig({ test: { fileParallelism: false } });
