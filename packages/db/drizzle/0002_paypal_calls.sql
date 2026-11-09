CREATE TYPE "public"."paypal_call_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "paypal_calls" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"tool" text NOT NULL,
	"profile" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" "paypal_call_status" DEFAULT 'pending' NOT NULL,
	"response" jsonb,
	"error" jsonb,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
