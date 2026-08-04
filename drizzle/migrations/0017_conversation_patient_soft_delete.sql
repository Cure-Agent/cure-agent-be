ALTER TABLE "conversations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_conversations_purge" ON "conversations" USING btree ("deleted_at") WHERE "conversations"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_patients_purge" ON "patients" USING btree ("deleted_at") WHERE "patients"."deleted_at" IS NOT NULL;
