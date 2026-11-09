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
  primaryKey,
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

// 3.3: seeded experiment batches -----------------------------------------------------------------------

export const batches = pgTable(
  "batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    seed: text("seed").notNull(),
    size: integer("size").notNull(),
    /** "sandbox" creates real PayPal invoices; "offline" uses simulated ids only. */
    mode: text("mode").notNull(),
    /** Simulator configuration in force when the batch was generated. */
    simConfig: jsonb("sim_config").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** The live loop only works a batch's treatment cases after the operator starts the run. */
    startedAt: timestamp("started_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("batches_seed_size_mode").on(t.seed, t.size, t.mode)],
);

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
    /** Seeded experiment batch this case belongs to (null for organic cases). */
    batchId: uuid("batch_id").references((): AnyPgColumn => batches.id),
    paused: boolean("paused").notNull().default(false),
    simulated: boolean("simulated").notNull().default(false),
    /** Customer-facing messages sent on this case. */
    contacts: integer("contacts").notNull().default(0),
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    /** yyyy-MM-dd the customer promised to pay by, if they did. */
    promiseDate: text("promise_date"),
    disputed: boolean("disputed").notNull().default(false),
    /** Latest status PayPal reported for the invoice or subscription. */
    paypalStatus: text("paypal_status"),
    /** Invoices: yyyy-MM-dd due date. */
    dueDate: text("due_date"),
    /** Subscriptions: failed payments PayPal has reported in this cycle. */
    failedPayments: integer("failed_payments").notNull().default(0),
    lastFailureReason: text("last_failure_reason"),
    /** Why the case reached its end state (gate rule, event, operator). */
    closeReason: text("close_reason"),
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

// 3.x: simulator ground truth and results ------------------------------------------------------------
// The decision loop must never read sim_profiles: it is the hidden customer behaviour the simulator plays.

export const simProfiles = pgTable("sim_profiles", {
  caseId: uuid("case_id")
    .primaryKey()
    .references(() => cases.id),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => batches.id),
  /** Position in the generated batch; keys the case's random streams so runs are reproducible. */
  batchIndex: integer("batch_index").notNull(),
  customerType: text("customer_type").notNull(),
  /** Subscription lane only: "soft" (may clear on retry) or "hard" (needs a new payment method). */
  failureKind: text("failure_kind"),
  hidden: jsonb("hidden").notNull(),
});

export const simRuns = pgTable("sim_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => batches.id),
  arm: experimentGroupEnum("arm").notNull(),
  strategy: text("strategy").notNull(),
  seed: text("seed").notNull(),
  simConfig: jsonb("sim_config").notNull(),
  metrics: jsonb("metrics"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const simCaseResults = pgTable(
  "sim_case_results",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => simRuns.id),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id),
    outcome: text("outcome").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    recoveredCents: bigint("recovered_cents", { mode: "number" }).notNull(),
    recoveredDay: integer("recovered_day"),
    contacts: integer("contacts").notNull(),
    contactsAfterOptOut: integer("contacts_after_opt_out").notNull(),
    timeline: jsonb("timeline").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.caseId] })],
);

// 4.14: scheduled case checks ----------------------------------------------------------------------------

export const jobStatusEnum = pgEnum("job_status", ["pending", "running", "done", "cancelled", "failed"]);

/** Due work for the worker: "check this case at this time". Cancelled when the case stops. */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id),
    kind: text("kind").notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    status: jobStatusEnum("status").notNull().default("pending"),
    reason: text("reason"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("jobs_due_idx").on(t.runAt).where(sql`${t.status} = 'pending'`), index("jobs_case_idx").on(t.caseId)],
);

// Gate rule 4: global kill switch ------------------------------------------------------------------------

export const systemState = pgTable("system_state", {
  id: integer("id").primaryKey().default(1),
  paused: boolean("paused").notNull().default(false),
  pausedBy: text("paused_by"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
});
