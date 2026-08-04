ALTER TABLE "clinicians" ALTER COLUMN "clinic_id" DROP NOT NULL;--> statement-breakpoint
CREATE TABLE "clinic_member_removals" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"removed_clinician_id" text NOT NULL,
	"removed_by_clinician_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinic_member_removals" ADD CONSTRAINT "clinic_member_removals_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_member_removals" ADD CONSTRAINT "clinic_member_removals_removed_clinician_id_clinicians_id_fk" FOREIGN KEY ("removed_clinician_id") REFERENCES "public"."clinicians"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_member_removals" ADD CONSTRAINT "clinic_member_removals_removed_by_clinician_id_clinicians_id_fk" FOREIGN KEY ("removed_by_clinician_id") REFERENCES "public"."clinicians"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_clinic_member_removals_clinic" ON "clinic_member_removals" USING btree ("clinic_id","created_at");
