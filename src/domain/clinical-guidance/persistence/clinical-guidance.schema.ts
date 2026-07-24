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
}

export interface GuidanceConsiderationJson {
  title: string;
  rationale: string;
  citations: GuidanceCitationJson[];
}

export interface SafetyAlertJson {
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  description: string;
  citations: GuidanceCitationJson[];
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
