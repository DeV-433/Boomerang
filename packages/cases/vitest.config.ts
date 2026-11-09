import { defineConfig } from "vitest/config";

// Database-backed tests share global state (the system pause, the audit chain): run files one at a time.
export default defineConfig({ test: { fileParallelism: false } });
