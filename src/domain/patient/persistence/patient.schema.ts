import { doublePrecision, index, integer, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';

export const patientSex = pgEnum('patient_sex', ['MALE', 'FEMALE', 'OTHER', 'UNKNOWN']);
export const patientStatus = pgEnum('patient_status', ['ACTIVE', 'ARCHIVED']);

/**
 * 환자 프로필 (§9). 민감 필드는 AES-GCM 암호문으로만 저장한다 (§4.5).
 * caseLabel은 비식별 라벨이라 평문(ILIKE 검색 대상).
 */
export const patients = pgTable(
  'patients',
  {
    id: text('id').primaryKey(), // ULID
    clinicId: text('clinic_id').notNull(), // §4.4 — 클리닉 공유 리소스 스코프
    caseLabel: text('case_label').notNull(),
    birthYear: integer('birth_year'),
    sex: patientSex('sex'),
    heightCm: doublePrecision('height_cm'),
    weightKg: doublePrecision('weight_kg'),
    waistCm: doublePrecision('waist_cm'),
    diagnosesEncrypted: text('diagnoses_encrypted').notNull(),
    medicationsEncrypted: text('medications_encrypted').notNull(),
    allergiesEncrypted: text('allergies_encrypted').notNull(),
    clinicalNotesEncrypted: text('clinical_notes_encrypted'),
    status: patientStatus('status').notNull().default('ACTIVE'),
    version: integer('version').notNull().default(1), // 낙관적 잠금 (§6)
    ...baseColumns,
  },
  (table) => [index('idx_patients_clinic').on(table.clinicId)],
);

/** 가이드 생성 당시 환자 프로필 immutable 스냅샷 (§9) — payload 전체 암호화 (§4.5) */
export const patientProfileSnapshots = pgTable(
  'patient_profile_snapshots',
  {
    id: text('id').primaryKey(),
    patientId: text('patient_id')
      .notNull()
      .references(() => patients.id),
    clinicId: text('clinic_id').notNull(),
    payloadEncrypted: text('payload_encrypted').notNull(),
    ...baseColumns,
  },
  (table) => [index('idx_patient_snapshots_patient').on(table.patientId)],
);

export type PatientRow = typeof patients.$inferSelect;
