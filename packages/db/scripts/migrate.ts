import { loadConfig, requireConfig } from "@boomerang/core";
import { runMigrations } from "../src/migrate";

const url = requireConfig(loadConfig(), "DATABASE_URL");
await runMigrations(url);
console.log("migrations applied");
