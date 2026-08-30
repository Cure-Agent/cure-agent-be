CREATE TYPE "public"."abstain_reason" AS ENUM('no_candidates', 'beyond_cutoff', 'insufficient_evidence');--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "abstain_reason" "abstain_reason";