import { index, jsonb, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';
import { clinicians } from '../../clinician/persistence/clinician.schema';
import { messages } from '../../conversation/persistence/conversation.schema';
import { patientProfileSnapshots, patients } from '../../patient/persistence/patient.schema';

export const guidanceReviewStatus = pgEnum('guidance_review_status', [
  'DRAFT',
  'ACCEPTED',
  'MODIFIED',
  'REJECTED',
]);
export const guidanceReviewDecision = pgEnum('guidance_review_decision', [
  'ACCEPTED',
  'MODIFIED',
  'REJECTED',
]);

/** jsonb 페이로드 — §7 ClinicalGuidanceResponseDto와 동형. 생성 시점에 고정되는 불변 내용 */
export interface GuidanceCitationJson {
  marker: number;
  evidenceId: string;
  guidelineTitle: string;
  guidelineVersion: string;
  sectionPath: string[];
  quote: string;
  sourceUrl: string;
  /**
   * 인용 번역 (docs/specs/44) — `toCitationDto`가 만든 값이 그대로 굳는다. 영문 참고안에는
   * 이미 런타임에 저장돼 왔고(관측 6/6), 여기 선언이 그것을 계약에 드러낸다. 한국어 참고안과
   * 과거 행에는 없으며 **키 부재로 닫힌다** — 빈 문자열을 싣지 않는다(§42 규율).
   */
  quoteTranslated?: string;
  titleTranslated?: string;
  sectionPathTranslated?: string[];
}

export interface GuidanceConsiderationJson {
  title: string;
  rationale: string;
  citations: GuidanceCitationJson[];
  /**
   * 구조화 경로(docs/specs/33)에서만 채워진다 — 폴백 행·기존 행에는 없다.
   * 어휘는 `GUIDANCE_APPLICABILITIES`(§7 DTO)가 집행한다.
   */
  applicability?: 'APPLICABLE' | 'CAUTION' | 'NOT_APPLICABLE';
  /** 이 판단이 딛고 선 환자 프로필 필드명 — missingInformation과 같은 어휘의 여집합 */
  patientFactors?: string[];
}

export interface SafetyAlertJson {
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  description: string;
  citations: GuidanceCitationJson[];
  /**
   * 경고가 딛고 선 알레르기명 (docs/specs/44) — **문장이 아니라 렌더의 재료다.**
   *
   * 알레르기명은 스냅샷의 환자 데이터이고 그것을 감싸는 문장은 우리가 소유한 정형구라,
   * §43이 기권 사유에 한 것처럼 행에 사유를 남기고 직렬화 시점에 문장을 만든다. 그래야
   * 참고안의 렌더 언어(`messages.response_lang`)를 따라 안내 문구가 본문과 같은 언어로 선다.
   * 이 키가 없는 과거 행은 저장된 `description`이 그대로 나간다.
   */
  allergen?: string;
}

/** 임상 가이던스 — 확정 처방이 아닌 검토 대상 참고안 (§5.6). 검토 상태만 가변 */
export const clinicalGuidances = pgTable(
  'clinical_guidances',
  {
    id: text('id').primaryKey(), // ULID
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id),
    patientId: text('patient_id')
      .notNull()
      .references(() => patients.id),
    patientSnapshotId: text('patient_snapshot_id')
      .notNull()
      .references(() => patientProfileSnapshots.id),
    clinicId: text('clinic_id').notNull(), // §4.4 — 환자 계열 리소스는 클리닉 스코프
    summary: text('summary').notNull(),
    considerations: jsonb('considerations').$type<GuidanceConsiderationJson[]>().notNull(),
    safetyAlerts: jsonb('safety_alerts').$type<SafetyAlertJson[]>().notNull(),
    missingInformation: text('missing_information').array().notNull(),
    /**
     * 이 행을 만든 조립 경로 (docs/specs/33) — `deterministic-v1` | `guidance-v1`.
     * §5.7 재현성 계약의 가이던스 축이다: 프롬프트 버전처럼 «당시 왜 이 참고안이 나왔는지»를
     * 되짚는 키라서, 응답 DTO에는 싣지 않고 기록으로만 남긴다.
     */
    composerVersion: text('composer_version').notNull().default('deterministic-v1'),
    reviewStatus: guidanceReviewStatus('review_status').notNull().default('DRAFT'),
    ...baseColumns,
  },
  (table) => [
    index('idx_clinical_guidances_clinic').on(table.clinicId),
    index('idx_clinical_guidances_message').on(table.messageId),
  ],
);

/** 의료인 검토 감사 기록 — guidance당 1회 (§5.6 재검토 금지) */
export const guidanceReviews = pgTable(
  'guidance_reviews',
  {
    id: text('id').primaryKey(),
    guidanceId: text('guidance_id')
      .notNull()
      .references(() => clinicalGuidances.id),
    clinicianId: text('clinician_id')
      .notNull()
      .references(() => clinicians.id),
    decision: guidanceReviewDecision('decision').notNull(),
    note: text('note'),
    ...baseColumns,
  },
  (table) => [index('idx_guidance_reviews_guidance').on(table.guidanceId)],
);

export type ClinicalGuidanceRow = typeof clinicalGuidances.$inferSelect;
export type GuidanceReviewRow = typeof guidanceReviews.$inferSelect;
