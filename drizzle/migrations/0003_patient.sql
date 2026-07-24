CREATE TYPE "public"."patient_sex" AS ENUM('MALE', 'FEMALE', 'OTHER', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."patient_status" AS ENUM('ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "patient_profile_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"clinic_id" text NOT NULL,
	"payload_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"case_label" text NOT NULL,
	"birth_year" integer,
	"sex" "patient_sex",
	"height_cm" double precision,
	"weight_kg" double precision,
	"waist_cm" double precision,
	"diagnoses_encrypted" text NOT NULL,
	"medications_encrypted" text NOT NULL,
	"allergies_encrypted" text NOT NULL,
	"clinical_notes_encrypted" text,
	"status" "patient_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patient_profile_snapshots" ADD CONSTRAINT "patient_profile_snapshots_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_patient_snapshots_patient" ON "patient_profile_snapshots" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_patients_clinic" ON "patients" USING btree ("clinic_id");