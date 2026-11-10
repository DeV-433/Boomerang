CREATE TABLE "sim_sensitivity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy" text NOT NULL,
	"size" integer NOT NULL,
	"seeds" jsonb NOT NULL,
	"base_config" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
