import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';
import { clinics } from './clinic.schema';

export const verificationStatus = pgEnum('verification_status', ['PENDING', 'VERIFIED', 'REJECTED']);
export const oauthProvider = pgEnum('oauth_provider', ['GOOGLE', 'KAKAO', 'NAVER']);
/**
 * 관리 엔드포인트 접근 권한 (docs/specs/21).
 * 토큰 페이로드에 넣지 않는다 — 박으면 권한 회수가 access TTL만큼 지연된다.
 * 최초 ADMIN 지정은 수동 UPDATE다 (역할 관리 API는 Out of scope).
 */
export const clinicianRole = pgEnum('clinician_role', ['ADMIN', 'MEMBER']);

export const clinicians = pgTable(
  'clinicians',
  {
    id: text('id').primaryKey(), // ULID
    /**
     * 소속 클리닉. **nullable이다** (docs/specs/38) — 강퇴당한 계정의 「소속 없음」을 표현한다.
     *
     * 무소속은 「**세션을 가질 수 없는 상태**」로 정의된다. `findById`·`findByOAuthAccount`가
     * `clinics`를 조인하므로 clinic이 없으면 세션 발급·복구 경로가 계정을 찾지 못하고, 그래서
     * `ClinicianPrincipal.clinicId`·JWT claim·§4.4 스코프는 여전히 non-null 전제 위에 선다.
     * 무소속에서 나가는 문은 재온보딩뿐이다(소셜 재로그인 → 온보딩 티켓 → 클리닉 개설·초대 합류).
     */
    clinicId: text('clinic_id').references(() => clinics.id),
    /**
     * 연락 수단이지 식별자가 아니다 — **unique를 걸지 않는다** (docs/specs/37).
     *
     * 제공자가 주는 미검증 값이라 소유권이 보장되지 않고, 여기에 unique를 걸면 계정 동일성
     * 기준이 `oauth_provider`+`oauth_provider_id`와 둘로 갈린다. 실제로 그 상태에서 같은
     * 이메일의 다른 소셜 계정이 프로덕션에서 2건 거절됐다.
     */
    email: text('email').notNull(),
    // 계정 동일성의 단일 기준 (docs/specs/17). 비밀번호는 저장하지 않는다.
    oauthProvider: oauthProvider('oauth_provider').notNull(),
    oauthProviderId: text('oauth_provider_id').notNull(),
    displayName: text('display_name').notNull(),
    // 면허번호는 AES-GCM 암호문으로만 저장한다 (architecture.md §4.5)
    licenseNumberEncrypted: text('license_number_encrypted').notNull(),
    verificationStatus: verificationStatus('verification_status').notNull().default('PENDING'),
    role: clinicianRole('role').notNull().default('MEMBER'),
    /**
     * 탈퇴 시각 (docs/specs/36) — 이 값이 찍힌 행은 **tombstone**이다.
     *
     * 행을 지우지 않는 이유는 `clinicians`를 참조하는 FK가 8개이고 그중 5개가 notNull이기 때문이다.
     * 특히 `answer_feedbacks`·`guidance_reviews`는 「누가 평가·검토했는가」가 기록의 본질이라
     * 작성자가 사라지면 감사 기록이 무의미해진다. 대화도 §35 이후 클리닉 공유 자산이라
     * 지우면 남은 동료가 보던 기록이 사라진다.
     *
     * 개인정보(email·oauthProviderId·displayName·licenseNumberEncrypted)는 이 시각과 **같은
     * 트랜잭션에서 즉시 익명화**된다 — 파기는 미룰 이유가 없다.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...baseColumns,
  },
  (table) => [
    // 계정 동일성의 **유일한** 제약이다 (docs/specs/37) — 이메일 unique는 0020에서 제거됐다
    uniqueIndex('uq_clinicians_oauth').on(table.oauthProvider, table.oauthProviderId),
    // 구성원 목록·파기 스캔은 탈퇴한 소수만 훑는다 (docs/specs/36)
    index('idx_clinicians_deleted')
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
  ],
);

export type ClinicianRow = typeof clinicians.$inferSelect;
