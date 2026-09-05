CREATE TABLE "keyword_chunk_index" (
	"chunk_id" text PRIMARY KEY NOT NULL,
	"ix" integer GENERATED ALWAYS AS IDENTITY (sequence name "keyword_chunk_index_ix_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keyword_vocab" (
	"term" text PRIMARY KEY NOT NULL,
	"chunk_ixs" integer[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "keyword_chunk_index" ADD CONSTRAINT "keyword_chunk_index_chunk_id_evidence_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."evidence_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_keyword_chunk_index_ix" ON "keyword_chunk_index" USING btree ("ix");