ALTER TABLE "conversations" ADD COLUMN "last_message_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "conversations" SET "last_message_at" = COALESCE(
	(SELECT max("messages"."created_at") FROM "messages" WHERE "messages"."conversation_id" = "conversations"."id"),
	"conversations"."created_at"
);--> statement-breakpoint
CREATE INDEX "idx_conversations_clinician_last_message" ON "conversations" USING btree ("clinician_id","last_message_at","id");--> statement-breakpoint
DROP INDEX "idx_conversations_clinician_recent";
