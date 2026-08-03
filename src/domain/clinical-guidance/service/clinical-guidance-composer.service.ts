import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { GuidanceStructureResult } from '../../../infrastructure/llm/guidance/guidance-structurer.port';
import { GUIDANCE_PROMPT_VERSION } from '../../../infrastructure/llm/guidance/guidance-prompt';
import { PatientSnapshotPayload } from '../../patient/service/patient-snapshot.service';
import { AnswerCitationResponseDto } from '../../conversation/dto/response/answer-citation.response.dto';
import { ClinicalGuidanceResponseDto } from '../dto/response/clinical-guidance.response.dto';
import { toClinicalGuidanceDto } from '../mapper/clinical-guidance.mapper';
import {
  GuidanceConsiderationJson,
  SafetyAlertJson,
} from '../persistence/clinical-guidance.schema';
import { ClinicalGuidanceRepository } from '../repository/clinical-guidance.repository';
import { validateStructuredConsiderations } from './guidance-consideration.validator';
import {
  missingGuidanceProfileFields,
  presentGuidanceProfileFields,
} from './guidance-profile-fields';

const SUMMARY_LIMIT = 200;

/** 구조화 없이 인용을 재배열한 경로 — 기존 행도 이 값이다 (docs/specs/33) */
export const DETERMINISTIC_COMPOSER_VERSION = 'deterministic-v1';

export interface ComposeGuidanceArgs {
  messageId: string;
  patientId: string;
  patientSnapshotId: string;
  clinicId: string;
  answerText: string;
  citations: AnswerCitationResponseDto[];
  profile: PatientSnapshotPayload;
  /** null이면 구조화 미시도·실패 — 결정적 조립으로 간다 (docs/specs/33) */
  structured: GuidanceStructureResult | null;
}

export interface ComposeGuidanceResult {
  guidance: ClinicalGuidanceResponseDto;
  /** 실제로 채용된 조립 경로 — 관측과 재현성(§5.7)의 축이라 호출측에 돌려준다 */
  composerVersion: string;
}

/**
 * 스트림 완료 시점의 답변·인용·스냅샷 프로필로 가이던스 참고안을 조립한다 (§5.6).
 *
 * 구조화 결과가 있으면 **검증을 통과한 항목만** 채용하고, 잔존 0이면 인용 재배열로 되돌린다
 * (docs/specs/33). summary·safetyAlerts·missingInformation은 어느 경로에서도 결정적이다 —
 * 알레르기 경고 같은 안전 규칙을 LLM 출력이 대체하지 못하게 하는 것이 계약이다(기준 6).
 */
@Injectable()
export class ClinicalGuidanceComposer {
  constructor(private readonly repository: ClinicalGuidanceRepository) {}

  /** 호출측 트랜잭션(CLS)에 참여한다 — 완료 tx 밖에서 단독 호출하지 않는다 */
  async compose(args: ComposeGuidanceArgs): Promise<ComposeGuidanceResult> {
    const validated = args.structured
      ? validateStructuredConsiderations({
          structured: args.structured,
          citations: args.citations,
          profileFields: presentGuidanceProfileFields(args.profile),
        })
      : [];
    const structuredAdopted = validated.length > 0;
    const composerVersion = structuredAdopted
      ? GUIDANCE_PROMPT_VERSION
      : DETERMINISTIC_COMPOSER_VERSION;

    const row = await this.repository.insert({
      id: ulid(),
      messageId: args.messageId,
      patientId: args.patientId,
      patientSnapshotId: args.patientSnapshotId,
      clinicId: args.clinicId,
      summary: buildSummary(args.answerText),
      considerations: structuredAdopted
        ? validated
        : buildConsiderations(args.answerText, args.citations),
      safetyAlerts: buildSafetyAlerts(args.profile),
      missingInformation: missingGuidanceProfileFields(args.profile),
      composerVersion,
    });
    return { guidance: toClinicalGuidanceDto(row), composerVersion };
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
