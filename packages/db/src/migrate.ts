import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

/** Arbitrary constant; serializes concurrent migration runs (parallel test files, overlapping deploys). */
const MIGRATION_LOCK_ID = 727_001;

export async function runMigrations(databaseUrl: string): Promise<void> {
  const host = new URL(databaseUrl).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || !host.includes(".");
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: local ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    }
  } finally {
    await client.end();
  }
}
