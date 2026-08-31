// docs/specs/44 BE 수용 기준 3·17 동결 테스트 — 구현 중 수정 금지

import type { PatientSnapshotPayload } from '../../patient/service/patient-snapshot.service';
import { toClinicalGuidanceDto } from '../mapper/clinical-guidance.mapper';
import type { ClinicalGuidanceRow } from '../persistence/clinical-guidance.schema';
import type { ClinicalGuidanceRepository } from '../repository/clinical-guidance.repository';
import { ClinicalGuidanceComposer } from './clinical-guidance-composer.service';

const CREATED_AT = new Date('2026-08-31T00:00:00.000Z');

function guidanceRow(
  overrides: Partial<ClinicalGuidanceRow> = {},
): ClinicalGuidanceRow {
  return {
    id: 'spec44-guidance-unit',
    messageId: 'spec44-message-unit',
    patientId: 'spec44-patient-unit',
    patientSnapshotId: 'spec44-snapshot-unit',
    clinicId: 'spec44-clinic-unit',
    summary: '합성 참고안 요약',
    considerations: [],
    safetyAlerts: [],
    missingInformation: [],
    composerVersion: 'guidance-v2',
    reviewStatus: 'DRAFT',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  } as ClinicalGuidanceRow;
}

describe('spec 44: 참고안 자유 문장 언어 계약', () => {
  it('[기준 3] ko 안전 경고는 allergen으로 오늘의 문장을 자구까지 그대로 렌더한다', () => {
    const row = guidanceRow({
      safetyAlerts: [
        {
          severity: 'WARNING',
          description: '__저장 문장 패스스루 금지__',
          citations: [],
          allergen: '페니실린',
        },
      ],
    });

    const dto = toClinicalGuidanceDto(row, 'ko');

    expect(dto.safetyAlerts).toEqual([
      {
        severity: 'WARNING',
        description:
          '환자에게 페니실린 알레르기 병력이 있습니다. 관련 계열 약물 권고 적용 전 교차 반응 여부를 확인하세요.',
        citations: [],
      },
    ]);
    expect(dto.safetyAlerts[0].description).not.toBe(
      row.safetyAlerts[0].description,
    );
  });

  it("[기준 17] 영문 인용 0건 폴백 제목은 영어이고 '근거 요약'이 아니다", async () => {
    const repository = {
      insert: jest.fn(async (input: Record<string, unknown>) =>
        guidanceRow(input as Partial<ClinicalGuidanceRow>),
      ),
    } as unknown as ClinicalGuidanceRepository;
    const composer = new ClinicalGuidanceComposer(repository);
    const profile = {
      patientId: 'spec44-patient-no-citation',
      patientVersion: 1,
      capturedAt: CREATED_AT.toISOString(),
      caseLabel: 'SPEC-44',
      birthYear: 1980,
      sex: 'FEMALE',
      heightCm: 165,
      weightKg: 60,
      waistCm: 75,
      diagnoses: [],
      medications: [],
      allergies: [],
      clinicalNotes: '',
    } as PatientSnapshotPayload;

    const result = await composer.compose({
      messageId: 'spec44-message-no-citation',
      patientId: 'spec44-patient-no-citation',
      patientSnapshotId: 'spec44-snapshot-no-citation',
      clinicId: 'spec44-clinic-no-citation',
      answerText: 'A synthetic English answer without citations.',
      citations: [],
      profile,
      structured: null,
      responseLang: 'en',
    });
    const title = result.guidance.considerations[0]?.title ?? '';

    expect(title).toMatch(/[A-Za-z]/);
    expect(title).not.toMatch(/[가-힣]/);
    expect(title).not.toBe('근거 요약');
  });
});
