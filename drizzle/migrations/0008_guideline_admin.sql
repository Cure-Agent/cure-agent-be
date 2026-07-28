CREATE TYPE "public"."clinician_role" AS ENUM('ADMIN', 'MEMBER');--> statement-breakpoint
CREATE TYPE "public"."guideline_version_status" AS ENUM('ACTIVE', 'SUPERSEDED');--> statement-breakpoint
DROP INDEX "uq_guideline_versions_version";--> statement-breakpoint
ALTER TABLE "clinicians" ADD COLUMN "role" "clinician_role" DEFAULT 'MEMBER' NOT NULL;--> statement-breakpoint
ALTER TABLE "guideline_versions" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "guideline_versions" ADD COLUMN "status" "guideline_version_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_guideline_versions_revision" ON "guideline_versions" USING btree ("guideline_id","version","revision");