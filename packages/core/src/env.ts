import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let loaded = false;

/**
 * Loads the repository's `.env` file into `process.env` once, if one exists.
 * Values already set in the environment win, so Render and CI settings are never overridden.
 */
export function loadEnv(startDir: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
