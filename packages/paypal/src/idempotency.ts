import { and, eq, lt, or, sql } from "drizzle-orm";
import { paypalCalls, type Database } from "@boomerang/db";

/**
 * Result of claiming an idempotency key before calling PayPal:
 * - "claimed": this caller owns the call and must report back with complete() or fail().
 * - "done": an earlier call with this key already succeeded; its response is returned instead.
 */
export type ClaimResult = { kind: "claimed"; attempt: number } | { kind: "done"; response: unknown };

export interface ClaimRequest {
  key: string;
  tool: string;
  profile: string;
  request: unknown;
}

export interface IdempotencyStore {
  claim(req: ClaimRequest): Promise<ClaimResult>;
  complete(key: string, response: unknown): Promise<void>;
  fail(key: string, error: unknown): Promise<void>;
}

export class IdempotencyInFlightError extends Error {
  constructor(readonly key: string) {
    super(`A PayPal call with idempotency key "${key}" is already in progress`);
    this.name = "IdempotencyInFlightError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(readonly key: string) {
    super(`Idempotency key "${key}" was already used for a different PayPal operation`);
    this.name = "IdempotencyConflictError";
  }
}

/** How long a pending claim is honoured before another worker may retake it (the first one crashed). */
export const CLAIM_LEASE_MS = 2 * 60 * 1000;

interface Row {
  tool: string;
  status: "pending" | "succeeded" | "failed";
  response: unknown;
  attempts: number;
  claimedAt: number;
}

/** In-memory store for unit tests and dry runs. Same semantics as the Postgres store. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly rows = new Map<string, Row>();
  constructor(private readonly now: () => number = Date.now) {}

  async claim({ key, tool }: ClaimRequest): Promise<ClaimResult> {
    const row = this.rows.get(key);
    if (!row) {
      this.rows.set(key, { tool, status: "pending", response: null, attempts: 1, claimedAt: this.now() });
      return { kind: "claimed", attempt: 1 };
    }
    if (row.tool !== tool) throw new IdempotencyConflictError(key);
    if (row.status === "succeeded") return { kind: "done", response: row.response };
    if (row.status === "pending" && this.now() - row.claimedAt < CLAIM_LEASE_MS)
      throw new IdempotencyInFlightError(key);
    row.status = "pending";
    row.attempts += 1;
    row.claimedAt = this.now();
    return { kind: "claimed", attempt: row.attempts };
  }

  async complete(key: string, response: unknown): Promise<void> {
    const row = this.rows.get(key);
    if (row) Object.assign(row, { status: "succeeded", response });
  }

  async fail(key: string): Promise<void> {
    const row = this.rows.get(key);
    if (row) row.status = "failed";
  }
}

function serializeError(error: unknown): unknown {
  if (error && typeof error === "object") {
    const e = error as {
      name?: string;
      message?: string;
      status?: number | null;
      body?: string;
      debugId?: string | null;
    };
    return {
      name: e.name,
      message: e.message,
      status: e.status ?? null,
      body: e.body,
      debugId: e.debugId ?? null,
    };
  }
  return { message: String(error) };
}

/** Postgres-backed store using the paypal_calls table. Claims are atomic across processes. */
export class PgIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Database) {}

  async claim({ key, tool, profile, request }: ClaimRequest): Promise<ClaimResult> {
    const inserted = await this.db
      .insert(paypalCalls)
      .values({ idempotencyKey: key, tool, profile, request: request ?? {} })
      .onConflictDoNothing({ target: paypalCalls.idempotencyKey })
      .returning({ attempts: paypalCalls.attempts });
    if (inserted.length > 0) return { kind: "claimed", attempt: 1 };

    // Retake a failed call, or a pending one whose lease ran out. Conditional, so only one caller wins.
    const lease = sql`now() - make_interval(secs => ${CLAIM_LEASE_MS / 1000})`;
    const retaken = await this.db
      .update(paypalCalls)
      .set({
        status: "pending",
        attempts: sql`${paypalCalls.attempts} + 1`,
        claimedAt: sql`now()`,
        error: null,
        completedAt: null,
      })
      .where(
        and(
          eq(paypalCalls.idempotencyKey, key),
          eq(paypalCalls.tool, tool),
          or(
            eq(paypalCalls.status, "failed"),
            and(eq(paypalCalls.status, "pending"), lt(paypalCalls.claimedAt, lease)),
          ),
        ),
      )
      .returning({ attempts: paypalCalls.attempts });
    if (retaken.length > 0) return { kind: "claimed", attempt: retaken[0]!.attempts };

    const [row] = await this.db.select().from(paypalCalls).where(eq(paypalCalls.idempotencyKey, key));
    if (!row) throw new IdempotencyInFlightError(key);
    if (row.tool !== tool) throw new IdempotencyConflictError(key);
    if (row.status === "succeeded") return { kind: "done", response: row.response };
    throw new IdempotencyInFlightError(key);
  }

  async complete(key: string, response: unknown): Promise<void> {
    await this.db
      .update(paypalCalls)
      .set({ status: "succeeded", response: response ?? null, completedAt: sql`now()` })
      .where(eq(paypalCalls.idempotencyKey, key));
  }

  async fail(key: string, error: unknown): Promise<void> {
    await this.db
      .update(paypalCalls)
      .set({ status: "failed", error: serializeError(error), completedAt: sql`now()` })
      .where(eq(paypalCalls.idempotencyKey, key));
  }
}
