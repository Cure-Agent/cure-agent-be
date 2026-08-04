ALTER TABLE "clinicians" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_clinicians_deleted" ON "clinicians" USING btree ("deleted_at") WHERE "clinicians"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_clinics_purge" ON "clinics" USING btree ("deleted_at") WHERE "clinics"."deleted_at" IS NOT NULL;
