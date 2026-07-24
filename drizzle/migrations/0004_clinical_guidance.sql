CREATE TYPE "public"."guidance_review_decision" AS ENUM('ACCEPTED', 'MODIFIED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."guidance_review_status" AS ENUM('DRAFT', 'ACCEPTED', 'MODIFIED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "clinical_guidances" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"patient_snapshot_id" text NOT NULL,
	"clinic_id" text NOT NULL,
	"summary" text NOT NULL,
	"considerations" jsonb NOT NULL,
	"safety_alerts" jsonb NOT NULL,
	"missing_information" text[] NOT NULL,
	"review_status" "guidance_review_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guidance_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"guidance_id" text NOT NULL,
	"clinician_id" text NOT NULL,
	"decision" "guidance_review_decision" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinical_guidances" ADD CONSTRAINT "clinical_guidances_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_guidances" ADD CONSTRAINT "clinical_guidances_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_guidances" ADD CONSTRAINT "clinical_guidances_patient_snapshot_id_patient_profile_snapshots_id_fk" FOREIGN KEY ("patient_snapshot_id") REFERENCES "public"."patient_profile_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance_reviews" ADD CONSTRAINT "guidance_reviews_guidance_id_clinical_guidances_id_fk" FOREIGN KEY ("guidance_id") REFERENCES "public"."clinical_guidances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance_reviews" ADD CONSTRAINT "guidance_reviews_clinician_id_clinicians_id_fk" FOREIGN KEY ("clinician_id") REFERENCES "public"."clinicians"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_clinical_guidances_clinic" ON "clinical_guidances" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_clinical_guidances_message" ON "clinical_guidances" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_guidance_reviews_guidance" ON "guidance_reviews" USING btree ("guidance_id");