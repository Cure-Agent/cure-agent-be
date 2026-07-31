CREATE TYPE "public"."guideline_job_trigger" AS ENUM('MANUAL', 'SCHEDULE');--> statement-breakpoint
ALTER TABLE "guideline_jobs" ALTER COLUMN "requested_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "guideline_jobs" ADD COLUMN "triggered_by" "guideline_job_trigger" DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "source_modified_at" text;