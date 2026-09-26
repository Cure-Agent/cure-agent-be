-- docs/specs/55 — 제목 규칙은 0015를 그대로 잇는다(런타임 deriveConversationTitle과 같은 규칙).
-- 0015와 다른 것은 마지막 EXISTS뿐이다: 런타임이 제목을 붙이는 조건(route 있는 완결)과 같은 경계다.
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
  AND f."cleaned" <> ''
  AND EXISTS (
    SELECT 1
    FROM "agent_turns" AS t
    JOIN "messages" AS a ON a."id" = t."message_id"
    WHERE a."conversation_id" = c."id"
      AND t."route" IS NOT NULL
  );
