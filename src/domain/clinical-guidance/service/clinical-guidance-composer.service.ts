import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { GuidanceStructureResult } from '../../../infrastructure/llm/guidance/guidance-structurer.port';
import { guidancePromptVersionFor } from '../../../infrastructure/llm/guidance/guidance-prompt';
import { SupportedLang } from '../../../infrastructure/llm/translation/translator.port';
import { PatientSnapshotPayload } from '../../patient/service/patient-snapshot.service';
import { AnswerCitationResponseDto } from '../../conversation/dto/response/answer-citation.response.dto';
import { ClinicalGuidanceResponseDto } from '../dto/response/clinical-guidance.response.dto';
import { renderSafetyAlert, toClinicalGuidanceDto } from '../mapper/clinical-guidance.mapper';
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
  /**
   * 이 참고안을 쓸 언어 (docs/specs/44). `considerations`는 구조화·폴백 **둘 다 생성 시점에
   * 굳고**, 안전 경고만 행에 알레르기명을 남겨 직렬화 시점에 문장이 된다.
   */
  responseLang: SupportedLang;
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
      ? guidancePromptVersionFor(args.responseLang)
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
        : buildConsiderations(args.answerText, args.citations, args.responseLang),
      safetyAlerts: buildSafetyAlerts(args.profile, args.responseLang),
      missingInformation: missingGuidanceProfileFields(args.profile),
      composerVersion,
    });
    return { guidance: toClinicalGuidanceDto(row, args.responseLang), composerVersion };
  }
}

function buildSummary(answerText: string): string {
  const text = answerText.trim();
  return text.length <= SUMMARY_LIMIT ? text : `${text.slice(0, SUMMARY_LIMIT)}…`;
}

/**
 * 인용 0건 폴백 항목의 제목 (docs/specs/44 기준 17).
 *
 * BE가 소유하는 것은 **자유 문장뿐**이다 — 필드 라벨(`patientFactors`·`missingInformation`)은
 * 닫힌 어휘라 FE가 i18n 키로 옮기고, BE가 렌더하면 이중이 된다(스펙 판단표).
 */
const FALLBACK_CONSIDERATION_TITLE: Record<SupportedLang, string> = {
  ko: '근거 요약',
  en: 'Evidence summary',
};

/**
 * 폴백 조립은 **생성 시점에 굳는다** (docs/specs/44) — 인용이 이미 들고 있는 번역을 그대로
 * 쓴다. 영문 경로에서 구조화가 상한을 넘기면 검토 항목이 통째로 한국어가 되는데, 관측되지
 * 않는 경로라 더 조용히 깨진다(영문 참고안 3건 전부 구조화 경로여서 폴백 표본이 0이다).
 */
function buildConsiderations(
  answerText: string,
  citations: AnswerCitationResponseDto[],
  responseLang: SupportedLang,
): GuidanceConsiderationJson[] {
  if (citations.length === 0) {
    // 인용 없는 완료 답변도 검토 항목 1건은 보장한다 (§7 considerations ≥ 1)
    return [
      {
        title: FALLBACK_CONSIDERATION_TITLE[responseLang],
        rationale: buildSummary(answerText),
        citations: [],
      },
    ];
  }
  return citations.map((citation) => {
    const title = citation.titleTranslated ?? citation.guidelineTitle;
    const path = citation.sectionPathTranslated ?? citation.sectionPath;
    return {
      title: path.length > 0 ? `${title} — ${path.join(' > ')}` : title,
      rationale: citation.quoteTranslated ?? citation.quote,
      citations: [citation],
    };
  });
}

/**
 * 알레르기 결정적 규칙 — 스냅샷에 고정된 알레르기명을 경고 본문에 그대로 노출한다.
 *
 * **문장과 함께 알레르기명을 행에 남긴다** (docs/specs/44). 문장은 `description`에 그대로
 * 들어가 jsonb를 직접 읽는 쪽도 읽을 수 있게 하되, 렌더는 매퍼가 `messages.response_lang`으로
 * 다시 만든다 — 같은 사실을 두 곳에 적는 것이 아니라, 저장은 **사유**(알레르기명)이고
 * 문장은 그 사유의 직렬화다(§43이 기권 사유에 딛고 선 자리와 같다).
 */
function buildSafetyAlerts(
  profile: PatientSnapshotPayload,
  responseLang: SupportedLang,
): SafetyAlertJson[] {
  return profile.allergies.map((allergy) => ({
    severity: 'WARNING' as const,
    description: renderSafetyAlert(allergy, responseLang),
    citations: [],
    allergen: allergy,
  }));
}
