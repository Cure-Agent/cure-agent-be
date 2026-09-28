-- docs/specs/56 — FE가 생성 시 굳힌 환자 대화 제목(「CASE-001 임상 참고 (9/28 14:30)」)을 런타임 규칙으로 채운다.
-- 질문 부분은 0015·0029를 그대로 잇는다(런타임 deriveConversationTitle과 같은 규칙). 라벨은 제목에서 캡처하지
-- 않고 **현재** patients.case_label을 쓴다 — 런타임이 수락 전에 읽는 것과 같은 원천이다. FE 틀과 다른 USER 제목은
-- 사람이 지은 이름이라 건드리지 않는다. deleted_at은 0029처럼 보지 않는다(파기가 지운다).
-- 두 문장 모두 재실행이 안전하다 — 갱신된 행은 출처가 더 이상 USER가 아니다.
-- (대상 테이블은 FROM 안의 JOIN ON에서 참조할 수 없어 환자는 WHERE로 잇는다.)

-- U1: 첫 USER 메시지가 있으면 「라벨 · 질문 40자」, AUTO
UPDATE "conversations" AS c
SET "title" = p."case_label" || ' · ' || CASE
      WHEN char_length(f."cleaned") > 40 THEN left(f."cleaned", 40) || '…'
      ELSE f."cleaned"
    END,
    "title_source" = 'AUTO'
FROM "patients" AS p,
  (
    SELECT DISTINCT ON (m."conversation_id")
           m."conversation_id" AS "conversation_id",
           btrim(regexp_replace(m."content", '\s+', ' ', 'g')) AS "cleaned"
    FROM "messages" AS m
    WHERE m."role" = 'USER'
    ORDER BY m."conversation_id", m."id" ASC
  ) AS f
WHERE p."id" = c."patient_id"
  AND f."conversation_id" = c."id"
  AND c."type" = 'PATIENT_GUIDANCE'
  AND c."title_source" = 'USER'
  AND c."title" ~ '^.+ (임상 참고|Clinical guidance) \(\d{1,2}/\d{1,2} \d{1,2}:\d{2}\)$'
  AND f."cleaned" <> '';
--> statement-breakpoint
-- U2: USER 메시지가 없으면 라벨만, DEFAULT — 다음 첫 질문이 런타임 규칙대로 제목을 완성한다
UPDATE "conversations" AS c
SET "title" = p."case_label",
    "title_source" = 'DEFAULT'
FROM "patients" AS p
WHERE p."id" = c."patient_id"
  AND c."type" = 'PATIENT_GUIDANCE'
  AND c."title_source" = 'USER'
  AND c."title" ~ '^.+ (임상 참고|Clinical guidance) \(\d{1,2}/\d{1,2} \d{1,2}:\d{2}\)$'
  AND NOT EXISTS (
    SELECT 1
    FROM "messages" AS m
    WHERE m."conversation_id" = c."id"
      AND m."role" = 'USER'
  );
