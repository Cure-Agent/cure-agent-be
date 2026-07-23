CREATE TYPE "public"."guideline_status" AS ENUM('ACTIVE', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."ingestion_status" AS ENUM('SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TABLE "evidence_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"section_id" text NOT NULL,
	"guideline_version_id" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"recommendation_number" text,
	"recommendation_grade" jsonb,
	"evidence_level" jsonb,
	"page_start" integer,
	"page_end" integer,
	"order" integer NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guideline_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"guideline_version_id" text NOT NULL,
	"title" text NOT NULL,
	"path" text[] NOT NULL,
	"order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guideline_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"guideline_id" text NOT NULL,
	"version" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"source_url" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guidelines" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"publisher" text NOT NULL,
	"status" "guideline_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"status" "ingestion_status" NOT NULL,
	"input_hash" text NOT NULL,
	"guideline_id" text,
	"guideline_version_id" text,
	"stats" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_chunks" ADD CONSTRAINT "evidence_chunks_section_id_guideline_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."guideline_sections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_chunks" ADD CONSTRAINT "evidence_chunks_guideline_version_id_guideline_versions_id_fk" FOREIGN KEY ("guideline_version_id") REFERENCES "public"."guideline_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guideline_sections" ADD CONSTRAINT "guideline_sections_guideline_version_id_guideline_versions_id_fk" FOREIGN KEY ("guideline_version_id") REFERENCES "public"."guideline_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guideline_versions" ADD CONSTRAINT "guideline_versions_guideline_id_guidelines_id_fk" FOREIGN KEY ("guideline_id") REFERENCES "public"."guidelines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evidence_chunks_version_hash" ON "evidence_chunks" USING btree ("guideline_version_id","content_hash");--> statement-breakpoint
CREATE INDEX "idx_evidence_chunks_section" ON "evidence_chunks" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "idx_guideline_sections_version" ON "guideline_sections" USING btree ("guideline_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_guideline_versions_version" ON "guideline_versions" USING btree ("guideline_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_guidelines_title_publisher" ON "guidelines" USING btree ("title","publisher");