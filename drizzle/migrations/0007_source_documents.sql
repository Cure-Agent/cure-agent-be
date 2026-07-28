CREATE TYPE "public"."source_document_status" AS ENUM('FETCHED', 'SKIPPED_NO_ATTACHMENT', 'FAILED');--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"source_system" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"publisher" text NOT NULL,
	"release_date" text,
	"source_url" text NOT NULL,
	"file_hash" text,
	"file_bytes" integer,
	"content_type" text,
	"status" "source_document_status" NOT NULL,
	"error" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_documents_external_hash" ON "source_documents" USING btree ("source_system","external_id","file_hash") WHERE "source_documents"."file_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_source_documents_external" ON "source_documents" USING btree ("source_system","external_id");