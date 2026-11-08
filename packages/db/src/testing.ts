import { loadEnv } from "@boomerang/core";
import { createDb, type DbHandle } from "./client";
import { runMigrations } from "./migrate";

/**
 * Test database URL. Database tests skip when none is configured locally, but in CI a missing
 * database is an error, so tests can never pass there by silently skipping.
 */
export function testDatabaseUrl(): string | undefined {
  loadEnv();
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || undefined;
  if (!url && process.env.CI) throw new Error("CI requires DATABASE_URL for database tests");
  return url;
}

export const hasTestDb = Boolean(testDatabaseUrl());

export async function setupTestDb(): Promise<DbHandle> {
  const url = testDatabaseUrl();
  if (!url) throw new Error("No test database configured");
  await runMigrations(url);
  return createDb(url, { max: 4 });
}
