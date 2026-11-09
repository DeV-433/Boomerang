CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'done', 'cancelled', 'failed');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "system_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "contacts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "last_contact_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "next_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "promise_date" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "disputed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "paypal_status" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "due_date" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "failed_payments" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "last_failure_reason" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "close_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "jobs_case_idx" ON "jobs" USING btree ("case_id");