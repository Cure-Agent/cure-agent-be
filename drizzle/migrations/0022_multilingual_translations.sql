CREATE TABLE "evidence_chunk_translations" (
	"id" text PRIMARY KEY NOT NULL,
	"chunk_id" text NOT NULL,
	"lang" text NOT NULL,
	"content" text NOT NULL,
	"source_content_hash" text NOT NULL,
	"translator_model" text NOT NULL,
	"translated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_chunk_translations" ADD CONSTRAINT "evidence_chunk_translations_chunk_id_evidence_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."evidence_chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_evidence_chunk_translations_chunk_lang" ON "evidence_chunk_translations" USING btree ("chunk_id","lang");--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "response_lang" text DEFAULT 'ko' NOT NULL;
