-- 소셜 로그인 전환 (docs/specs/17): 비밀번호 폐기 + 소셜 신원(provider + providerId) 도입.
-- 기존 계정은 소셜 신원이 없어 자동 이관이 불가능하다 — 행이 남아 있으면 여기서 멈춘다.
-- 데모 데이터를 비우려면 참조 테이블부터 정리한 뒤 재실행할 것:
--   TRUNCATE clinicians, clinics, auth_sessions, patients, conversations, clinical_guidances CASCADE;
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "clinicians") THEN
		RAISE EXCEPTION '기존 clinicians 행은 소셜 신원으로 이관할 수 없습니다. 데이터를 정리한 뒤 다시 실행하세요.';
	END IF;
END $$;--> statement-breakpoint
CREATE TYPE "public"."oauth_provider" AS ENUM('GOOGLE', 'KAKAO', 'NAVER');--> statement-breakpoint
ALTER TABLE "clinicians" ADD COLUMN "oauth_provider" "oauth_provider" NOT NULL;--> statement-breakpoint
ALTER TABLE "clinicians" ADD COLUMN "oauth_provider_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "clinicians" DROP COLUMN "password_hash";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_clinicians_oauth" ON "clinicians" USING btree ("oauth_provider","oauth_provider_id");
