CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"seed" text NOT NULL,
	"size" integer NOT NULL,
	"mode" text NOT NULL,
	"sim_config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_case_results" (
	"run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"recovered_cents" bigint NOT NULL,
	"recovered_day" integer,
	"contacts" integer NOT NULL,
	"contacts_after_opt_out" integer NOT NULL,
	"timeline" jsonb NOT NULL,
	CONSTRAINT "sim_case_results_run_id_case_id_pk" PRIMARY KEY("run_id","case_id")
);
--> statement-breakpoint
CREATE TABLE "sim_profiles" (
	"case_id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"batch_index" integer NOT NULL,
	"customer_type" text NOT NULL,
	"failure_kind" text,
	"hidden" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"arm" "experiment_group" NOT NULL,
	"strategy" text NOT NULL,
	"seed" text NOT NULL,
	"sim_config" jsonb NOT NULL,
	"metrics" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "sim_case_results" ADD CONSTRAINT "sim_case_results_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_case_results" ADD CONSTRAINT "sim_case_results_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_profiles" ADD CONSTRAINT "sim_profiles_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_profiles" ADD CONSTRAINT "sim_profiles_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_runs" ADD CONSTRAINT "sim_runs_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batches_seed_size_mode" ON "batches" USING btree ("seed","size","mode");--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;