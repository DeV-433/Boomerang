ALTER TYPE "public"."approval_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "invoice_number" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "system_state" ADD COLUMN "worker_mode" "policy_mode";--> statement-breakpoint
ALTER TABLE "system_state" ADD COLUMN "worker_seen_at" timestamp with time zone;