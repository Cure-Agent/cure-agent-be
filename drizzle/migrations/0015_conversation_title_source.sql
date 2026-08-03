CREATE TYPE "public"."conversation_title_source" AS ENUM('DEFAULT', 'AUTO', 'USER');--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "title_source" "conversation_title_source" DEFAULT 'DEFAULT' NOT NULL;--> statement-breakpoint
UPDATE "conversations" SET "title_source" = 'USER' WHERE "title" <> '새 대화';--> statement-breakpoint
UPDATE "conversations" AS c
SET "title" = CASE
      WHEN char_length(f."cleaned") > 40 THEN left(f."cleaned", 40) || '…'
      ELSE f."cleaned"
    END,
    "title_source" = 'AUTO'
FROM (
  SELECT DISTINCT ON (m."conversation_id")
         m."conversation_id" AS "conversation_id",
         btrim(regexp_replace(m."content", '\s+', ' ', 'g')) AS "cleaned"
  FROM "messages" AS m
  WHERE m."role" = 'USER'
  ORDER BY m."conversation_id", m."id" ASC
) AS f
WHERE c."id" = f."conversation_id"
  AND c."title_source" = 'DEFAULT'
  AND c."type" = 'GUIDELINE_QA'
  AND f."cleaned" <> '';
