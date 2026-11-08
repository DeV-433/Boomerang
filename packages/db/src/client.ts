import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema> & { $client: pg.Pool };

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

/** Render's managed Postgres requires TLS on external connections; local Docker does not. */
function sslFor(url: string): pg.PoolConfig["ssl"] {
  const host = new URL(url).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || !host.includes(".");
  return local ? undefined : { rejectUnauthorized: false };
}

export function createDb(databaseUrl: string, options: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: options.max ?? 10, ssl: sslFor(databaseUrl) });
  const db = drizzle(pool, { schema }) as Database;
  return { db, pool, close: () => pool.end() };
}

/** Cheap liveness probe used by /healthz and the worker. */
export async function pingDb(pool: pg.Pool): Promise<void> {
  await pool.query("select 1");
}
