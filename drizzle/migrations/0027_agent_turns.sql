CREATE TYPE "public"."agent_route" AS ENUM('GUIDELINE', 'PATIENT', 'COMPOSITE', 'OTHER');--> statement-breakpoint
ALTER TYPE "public"."abstain_reason" ADD VALUE 'out_of_scope';--> statement-breakpoint
ALTER TYPE "public"."abstain_reason" ADD VALUE 'patient_unresolved';--> statement-breakpoint
CREATE TABLE "agent_turns" (
	"message_id" text PRIMARY KEY NOT NULL,
	"user_message_id" text NOT NULL,
	"route" "agent_route",
	"classifier_version" text,
	"patient_snapshot_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generation_runs" ALTER COLUMN "retrieval_policy_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_user_message_id_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_patient_snapshot_id_patient_profile_snapshots_id_fk" FOREIGN KEY ("patient_snapshot_id") REFERENCES "public"."patient_profile_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_turns_patient_snapshot" ON "agent_turns" USING btree ("patient_snapshot_id") WHERE "agent_turns"."patient_snapshot_id" IS NOT NULL;