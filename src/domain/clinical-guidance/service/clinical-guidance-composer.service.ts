import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { PatientSnapshotPayload } from '../../patient/service/patient-snapshot.service';
import { AnswerCitationResponseDto } from '../../conversation/dto/response/answer-citation.response.dto';
import { ClinicalGuidanceResponseDto } from '../dto/response/clinical-guidance.response.dto';
import { toClinicalGuidanceDto } from '../mapper/clinical-guidance.mapper';
import {
  GuidanceConsiderationJson,
  SafetyAlertJson,
} from '../persistence/clinical-guidance.schema';
import { ClinicalGuidanceRepository } from '../repository/clinical-guidance.repository';

const SUMMARY_LIMIT = 200;

export interface ComposeGuidanceArgs {
  messageId: string;
  patientId: string;
  patientSnapshotId: string;
  clinicId: string;
  answerText: string;
  citations: AnswerCitationResponseDto[];
  profile: PatientSnapshotPayload;
}

/**
 * 스트림 완료 시점의 답변·인용·스냅샷 프로필로 가이던스 참고안을 결정적으로 조립한다 (§5.6).
 * LLM 구조화 출력은 spec 07 범위 — 여기서는 인용·알레르기 기반 규칙만 사용한다.
 */
@Injectable()
export class ClinicalGuidanceComposer {
  constructor(private readonly repository: ClinicalGuidanceRepository) {}

  /** 호출측 트랜잭션(CLS)에 참여한다 — 완료 tx 밖에서 단독 호출하지 않는다 */
  async compose(args: ComposeGuidanceArgs): Promise<ClinicalGuidanceResponseDto> {
    const row = await this.repository.insert({
      id: ulid(),
      messageId: args.messageId,
      patientId: args.patientId,
      patientSnapshotId: args.patientSnapshotId,
      clinicId: args.clinicId,
      summary: buildSummary(args.answerText),
      considerations: buildConsiderations(args.answerText, args.citations),
      safetyAlerts: buildSafetyAlerts(args.profile),
      missingInformation: buildMissingInformation(args.profile),
    });
    return toClinicalGuidanceDto(row);
  }
}

function buildSummary(answerText: string): string {
  const text = answerText.trim();
  return text.length <= SUMMARY_LIMIT ? text : `${text.slice(0, SUMMARY_LIMIT)}…`;
}

function buildConsiderations(
  answerText: string,
  citations: AnswerCitationResponseDto[],
): GuidanceConsiderationJson[] {
  if (citations.length === 0) {
    // 인용 없는 완료 답변도 검토 항목 1건은 보장한다 (§7 considerations ≥ 1)
    return [{ title: '근거 요약', rationale: buildSummary(answerText), citations: [] }];
  }
  return citations.map((citation) => ({
    title:
      citation.sectionPath.length > 0
        ? `${citation.guidelineTitle} — ${citation.sectionPath.join(' > ')}`
        : citation.guidelineTitle,
    rationale: citation.quote,
    citations: [citation],
  }));
}

/** 알레르기 결정적 규칙 — 스냅샷에 고정된 알레르기명을 경고 본문에 그대로 노출한다 */
function buildSafetyAlerts(profile: PatientSnapshotPayload): SafetyAlertJson[] {
  return profile.allergies.map((allergy) => ({
    severity: 'WARNING' as const,
    description: `환자에게 ${allergy} 알레르기 병력이 있습니다. 관련 계열 약물 권고 적용 전 교차 반응 여부를 확인하세요.`,
    citations: [],
  }));
}

function buildMissingInformation(profile: PatientSnapshotPayload): string[] {
  const missing: string[] = [];
  if (profile.birthYear === null) missing.push('출생연도');
  if (profile.sex === null) missing.push('성별');
  if (profile.heightCm === null) missing.push('신장');
  if (profile.weightKg === null) missing.push('체중');
  if (profile.waistCm === null) missing.push('허리둘레');
  if (profile.diagnoses.length === 0) missing.push('진단명');
  if (profile.medications.length === 0) missing.push('투약 목록');
  if (profile.allergies.length === 0) missing.push('알레르기 이력');
  if (!profile.clinicalNotes) missing.push('임상 메모');
  return missing;
}
