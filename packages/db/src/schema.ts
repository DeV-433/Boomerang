import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// Enums ----------------------------------------------------------------------------------------------

export const laneEnum = pgEnum("lane", ["invoice", "subscription"]);

/** Case states from section 8 of the project documentation. Recovered, stopped and escalated are final. */
export const caseStateEnum = pgEnum("case_state", [
  "detected",
  "diagnosed",
  "proposed",
  "approval",
  "executed",
  "awaiting",
  "recovered",
  "stopped",
  "escalated",
]);

export const experimentGroupEnum = pgEnum("experiment_group", ["control", "treatment"]);
export const gateVerdictEnum = pgEnum("gate_verdict", ["allow", "hold", "block"]);
export const actionStatusEnum = pgEnum("action_status", [
  "proposed",
  "held",
  "blocked",
  "approved",
  "executed",
  "failed",
  "cancelled",
]);
export const approvalStatusEnum = pgEnum("approval_status", ["pending", "approved", "edited", "rejected"]);
export const policyModeEnum = pgEnum("policy_mode", ["dry_run", "live"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// 1.4: customers, cases, events -----------------------------------------------------------------------

export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  paypalPayerRef: text("paypal_payer_ref").unique(),
  email: text("email"),
  name: text("name"),
  optedOut: boolean("opted_out").notNull().default(false),
  optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
  /** IANA time zone. Null means "fall back to the merchant's zone with narrower hours". */
  timezone: text("timezone"),
  simulated: boolean("simulated").notNull().default(false),
  createdAt: createdAt(),
});

export const cases = pgTable(
  "cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lane: laneEnum("lane").notNull(),
    /** PayPal invoice id or subscription id. */
    paypalRef: text("paypal_ref").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    /** Amount at risk in minor units (cents) to avoid floating-point money. */
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    state: caseStateEnum("state").notNull().default("detected"),
    cause: text("cause"),
    stage: integer("stage").notNull().default(0),
    recoveredCents: bigint("recovered_cents", { mode: "number" }).notNull().default(0),
    experimentGroup: experimentGroupEnum("experiment_group"),
    /** A reopened issue creates a new case linked to the old one, because end states are final. */
    parentCaseId: uuid("parent_case_id").references((): AnyPgColumn => cases.id),
    paused: boolean("paused").notNull().default(false),
    simulated: boolean("simulated").notNull().default(false),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one open case per PayPal object, so a poller or a duplicate event cannot open two.
    uniqueIndex("cases_one_open_per_ref").on(t.lane, t.paypalRef).where(sql`${t.closedAt} is null`),
    index("cases_state_idx").on(t.state),
    index("cases_customer_idx").on(t.customerId),
  ],
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** PayPal's event id. Unique, so a webhook delivered twice is stored once. */
    paypalEventId: text("paypal_event_id").notNull().unique(),
    type: text("type").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    payload: jsonb("payload").notNull(),
    /** The exact bytes PayPal sent, kept for signature re-verification and replay. */
    rawBody: text("raw_body").notNull(),
    headers: jsonb("headers").notNull(),
    /** "webhook", "poll" or "simulated". */
    source: text("source").notNull().default("webhook"),
    simulated: boolean("simulated").notNull().default(false),
    caseId: uuid("case_id").references(() => cases.id),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("events_unprocessed_idx").on(t.receivedAt).where(sql`${t.processedAt} is null`),
    index("events_case_idx").on(t.caseId),
  ],
);

// 1.5: actions, approvals, policies -------------------------------------------------------------------

export const actions = pgTable(
  "actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id),
    action: text("action").notNull(),
    /** "rules", "agent:<model>" or "operator:<id>". */
    proposedBy: text("proposed_by").notNull(),
    reason: text("reason"),
    confidence: real("confidence"),
    message: jsonb("message"),
    status: actionStatusEnum("status").notNull().default("proposed"),
    gateVerdict: gateVerdictEnum("gate_verdict"),
    gateReasons: jsonb("gate_reasons"),
    policyVersion: integer("policy_version"),
    toolCall: jsonb("tool_call"),
    toolResponse: jsonb("tool_response"),
    /** Derived from case and action; recorded before the PayPal call so a retry cannot double-send. */
    idempotencyKey: text("idempotency_key").unique(),
    createdAt: createdAt(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
  },
  (t) => [index("actions_case_idx").on(t.caseId)],
);

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  actionId: uuid("action_id")
    .notNull()
    .unique()
    .references(() => actions.id),
  status: approvalStatusEnum("status").notNull().default("pending"),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  note: text("note"),
  editedMessage: jsonb("edited_message"),
  createdAt: createdAt(),
});

export const policies = pgTable(
  "policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: text("merchant_id").notNull(),
    version: integer("version").notNull(),
    mode: policyModeEnum("mode").notNull().default("dry_run"),
    caps: jsonb("caps").notNull(),
    hours: jsonb("hours").notNull(),
    thresholds: jsonb("thresholds").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("policies_merchant_version").on(t.merchantId, t.version)],
);

// 1.6: append-only audit log --------------------------------------------------------------------------

export const auditLog = pgTable(
  "audit_log",
  {
    /** Monotonic sequence; the hash chain is walked in this order. */
    id: bigserial("id", { mode: "number" }).primaryKey(),
    caseId: uuid("case_id").references(() => cases.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor").notNull(),
    kind: text("kind").notNull(),
    data: jsonb("data").notNull(),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull().unique(),
  },
  (t) => [index("audit_log_case_idx").on(t.caseId, t.id)],
);

// 2.5: outbound PayPal call ledger ---------------------------------------------------------------------

export const paypalCallStatusEnum = pgEnum("paypal_call_status", ["pending", "succeeded", "failed"]);

/**
 * One row per idempotency key. The key is claimed here before PayPal is called, so the same
 * logical action (case + action + stage) can never be sent twice, even across retries or workers.
 */
export const paypalCalls = pgTable("paypal_calls", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  tool: text("tool").notNull(),
  profile: text("profile").notNull(),
  request: jsonb("request").notNull(),
  status: paypalCallStatusEnum("status").notNull().default("pending"),
  response: jsonb("response"),
  error: jsonb("error"),
  attempts: integer("attempts").notNull().default(1),
  createdAt: createdAt(),
  /** When the current attempt claimed the key; a stale pending claim (crashed worker) can be retaken. */
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
