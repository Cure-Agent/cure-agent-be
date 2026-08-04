CREATE TABLE "clinic_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"invited_by_clinician_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_clinician_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "owner_clinician_id" text;--> statement-breakpoint
ALTER TABLE "clinic_invitations" ADD CONSTRAINT "clinic_invitations_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_invitations" ADD CONSTRAINT "clinic_invitations_invited_by_clinician_id_clinicians_id_fk" FOREIGN KEY ("invited_by_clinician_id") REFERENCES "public"."clinicians"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_invitations" ADD CONSTRAINT "clinic_invitations_accepted_by_clinician_id_clinicians_id_fk" FOREIGN KEY ("accepted_by_clinician_id") REFERENCES "public"."clinicians"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_owner_clinician_id_clinicians_id_fk" FOREIGN KEY ("owner_clinician_id") REFERENCES "public"."clinicians"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_clinic_invitations_clinic" ON "clinic_invitations" USING btree ("clinic_id","created_at");--> statement-breakpoint
UPDATE "clinics" SET "owner_clinician_id" = (
	SELECT c."id" FROM "clinicians" c
	WHERE c."clinic_id" = "clinics"."id"
	ORDER BY c."created_at" ASC, c."id" ASC
	LIMIT 1
) WHERE "owner_clinician_id" IS NULL;--> statement-breakpoint
DROP INDEX "idx_conversations_clinician_last_message";--> statement-breakpoint
CREATE INDEX "idx_conversations_clinic_last_message" ON "conversations" USING btree ("clinic_id","last_message_at","id");
