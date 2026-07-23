CREATE TYPE "public"."answer_kind" AS ENUM('GUIDELINE_ANSWER', 'CLINICAL_GUIDANCE');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."conversation_type" AS ENUM('GUIDELINE_QA', 'PATIENT_GUIDANCE');--> statement-breakpoint
CREATE TYPE "public"."feedback_rating" AS ENUM('HELPFUL', 'NOT_HELPFUL');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('USER', 'ASSISTANT');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('STREAMING', 'COMPLETED', 'ABSTAINED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "answer_feedbacks" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"clinician_id" text NOT NULL,
	"rating" "feedback_rating" NOT NULL,
	"reason_codes" text[],
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"clinician_id" text NOT NULL,
	"clinic_id" text NOT NULL,
	"type" "conversation_type" NOT NULL,
	"patient_id" text,
	"title" text NOT NULL,
	"status" "conversation_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"retrieval_policy_version" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"token_usage" jsonb,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_citations" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"evidence_chunk_id" text NOT NULL,
	"marker" integer NOT NULL,
	"quote" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"status" "message_status" NOT NULL,
	"answer_kind" "answer_kind",
	"client_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answer_feedbacks" ADD CONSTRAINT "answer_feedbacks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_feedbacks" ADD CONSTRAINT "answer_feedbacks_clinician_id_clinicians_id_fk" FOREIGN KEY ("clinician_id") REFERENCES "public"."clinicians"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_clinician_id_clinicians_id_fk" FOREIGN KEY ("clinician_id") REFERENCES "public"."clinicians"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_citations" ADD CONSTRAINT "message_citations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_citations" ADD CONSTRAINT "message_citations_evidence_chunk_id_evidence_chunks_id_fk" FOREIGN KEY ("evidence_chunk_id") REFERENCES "public"."evidence_chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_answer_feedbacks_message_clinician" ON "answer_feedbacks" USING btree ("message_id","clinician_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_clinician" ON "conversations" USING btree ("clinician_id");--> statement-breakpoint
CREATE INDEX "idx_message_citations_message" ON "message_citations" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_messages_client_request" ON "messages" USING btree ("client_request_id");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation" ON "messages" USING btree ("conversation_id");