CREATE TYPE "public"."guideline_job_status" AS ENUM('RUNNING', 'COMPLETED', 'CANCELLING', 'CANCELLED', 'INTERRUPTED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."pipeline_run_phase" AS ENUM('ACQUIRE', 'PARSE', 'EMBED', 'INGEST');--> statement-breakpoint
CREATE TYPE "public"."pipeline_run_status" AS ENUM('RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED', 'INTERRUPTED');--> statement-breakpoint
CREATE TABLE "guideline_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"status" "guideline_job_status" DEFAULT 'RUNNING' NOT NULL,
	"requested_by" text NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text,
	"order" integer DEFAULT 0 NOT NULL,
	"source_system" text,
	"external_id" text,
	"status" "pipeline_run_status" DEFAULT 'RUNNING' NOT NULL,
	"phase" "pipeline_run_phase" DEFAULT 'ACQUIRE' NOT NULL,
	"error_code" text,
	"error" text,
	"input_hash" text,
	"guideline_id" text,
	"guideline_version_id" text,
	"revision" integer,
	"created" boolean,
	"stages" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guideline_jobs" ADD CONSTRAINT "guideline_jobs_requested_by_clinicians_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."clinicians"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_job_id_guideline_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."guideline_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_guideline_jobs_active" ON "guideline_jobs" USING btree ((true)) WHERE "guideline_jobs"."status" IN ('RUNNING', 'CANCELLING');--> statement-breakpoint
CREATE INDEX "idx_pipeline_runs_job_order" ON "pipeline_runs" USING btree ("job_id","order");--> statement-breakpoint
CREATE INDEX "idx_pipeline_runs_external" ON "pipeline_runs" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "idx_pipeline_runs_status" ON "pipeline_runs" USING btree ("status");