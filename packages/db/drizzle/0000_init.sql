CREATE TYPE "public"."action_status" AS ENUM('proposed', 'held', 'blocked', 'approved', 'executed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'edited', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."case_state" AS ENUM('detected', 'diagnosed', 'proposed', 'approval', 'executed', 'awaiting', 'recovered', 'stopped', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."experiment_group" AS ENUM('control', 'treatment');--> statement-breakpoint
CREATE TYPE "public"."gate_verdict" AS ENUM('allow', 'hold', 'block');--> statement-breakpoint
CREATE TYPE "public"."lane" AS ENUM('invoice', 'subscription');--> statement-breakpoint
CREATE TYPE "public"."policy_mode" AS ENUM('dry_run', 'live');--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"action" text NOT NULL,
	"proposed_by" text NOT NULL,
	"reason" text,
	"confidence" real,
	"message" jsonb,
	"status" "action_status" DEFAULT 'proposed' NOT NULL,
	"gate_verdict" "gate_verdict",
	"gate_reasons" jsonb,
	"policy_version" integer,
	"tool_call" jsonb,
	"tool_response" jsonb,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	CONSTRAINT "actions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"note" text,
	"edited_message" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_action_id_unique" UNIQUE("action_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"case_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	CONSTRAINT "audit_log_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lane" "lane" NOT NULL,
	"paypal_ref" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"state" "case_state" DEFAULT 'detected' NOT NULL,
	"cause" text,
	"stage" integer DEFAULT 0 NOT NULL,
	"recovered_cents" bigint DEFAULT 0 NOT NULL,
	"experiment_group" "experiment_group",
	"parent_case_id" uuid,
	"paused" boolean DEFAULT false NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paypal_payer_ref" text,
	"email" text,
	"name" text,
	"opted_out" boolean DEFAULT false NOT NULL,
	"opted_out_at" timestamp with time zone,
	"timezone" text,
	"simulated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_paypal_payer_ref_unique" UNIQUE("paypal_payer_ref")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paypal_event_id" text NOT NULL,
	"type" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"payload" jsonb NOT NULL,
	"raw_body" text NOT NULL,
	"headers" jsonb NOT NULL,
	"source" text DEFAULT 'webhook' NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"case_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "events_paypal_event_id_unique" UNIQUE("paypal_event_id")
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" text NOT NULL,
	"version" integer NOT NULL,
	"mode" "policy_mode" DEFAULT 'dry_run' NOT NULL,
	"caps" jsonb NOT NULL,
	"hours" jsonb NOT NULL,
	"thresholds" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_parent_case_id_cases_id_fk" FOREIGN KEY ("parent_case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actions_case_idx" ON "actions" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "audit_log_case_idx" ON "audit_log" USING btree ("case_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_one_open_per_ref" ON "cases" USING btree ("lane","paypal_ref") WHERE "cases"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "cases_state_idx" ON "cases" USING btree ("state");--> statement-breakpoint
CREATE INDEX "cases_customer_idx" ON "cases" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "events_unprocessed_idx" ON "events" USING btree ("received_at") WHERE "events"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "events_case_idx" ON "events" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_merchant_version" ON "policies" USING btree ("merchant_id","version");