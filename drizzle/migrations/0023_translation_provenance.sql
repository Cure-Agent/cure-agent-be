ALTER TABLE "evidence_chunk_translations" ADD COLUMN "title_translated" text;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "original_question" text;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "search_question" text;
