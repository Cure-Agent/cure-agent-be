/**
 * 구조화 결과의 결정적 검증기 (docs/specs/33).
 *
 * 프롬프트를 믿지 않는 것이 이 스펙의 전제다 — 「적용 판단」이 창작이 아니려면 두 전제(근거 원문·
 * 환자 프로필)가 모두 **입력 안에 있었음**을 코드가 확인할 수 있어야 한다. 확인되지 않는 항목은
 * 폐기하고, 잔존 0이면 호출측이 결정적 조립으로 되돌린다.
 */
import {
  GuidanceProfileField,
  GuidanceStructureResult,
  StructuredConsideration,
} from '../../../infrastructure/llm/guidance/guidance-structurer.port';
import { AnswerCitationResponseDto } from '../../conversation/dto/response/answer-citation.response.dto';
import { GUIDANCE_APPLICABILITIES, GuidanceApplicability } from '../dto/response/clinical-guidance.response.dto';
import { GuidanceConsiderationJson } from '../persistence/clinical-guidance.schema';

export interface ValidateStructuredConsiderationsInput {
  structured: GuidanceStructureResult;
  /** 답변이 실제 영속화한 인용 — 근거 다리의 유일한 원천 */
  citations: AnswerCitationResponseDto[];
  /** 값이 채워진 프로필 필드 — 환자 다리의 유일한 원천 */
  profileFields: GuidanceProfileField[];
}

/**
 * 항목 단위로 검증한다 — 어긋난 **항목만** 폐기하고 유효한 나머지는 남긴다.
 * **빈 배열이 폴백 신호다** (docs/specs/33 기준 2⑻).
 */
export function validateStructuredConsiderations(
  input: ValidateStructuredConsiderationsInput,
): GuidanceConsiderationJson[] {
  const citationByMarker = new Map(input.citations.map((citation) => [citation.marker, citation]));
  const allowedFields = new Set(input.profileFields.map((field) => field.field));
  const considerations = Array.isArray(input.structured?.considerations)
    ? input.structured.considerations
    : [];

  return considerations.flatMap((item) => {
    const accepted = accept(item, citationByMarker, allowedFields);
    return accepted === null ? [] : [accepted];
  });
}

function accept(
  item: StructuredConsideration,
  citationByMarker: Map<number, AnswerCitationResponseDto>,
  allowedFields: Set<string>,
): GuidanceConsiderationJson | null {
  if (!isFilled(item?.title) || !isFilled(item?.rationale)) return null;
  if (!isApplicability(item.applicability)) return null;

  // 두 다리는 **1개 이상**이어야 한다 — 빈 배열은 부분집합 조건을 자동 통과하므로 따로 막는다
  const markers = Array.isArray(item.markers) ? item.markers : [];
  if (markers.length === 0) return null;
  const citations = markers.map((marker) => citationByMarker.get(marker));
  if (citations.some((citation) => citation === undefined)) return null;

  const patientFactors = Array.isArray(item.patientFactors) ? item.patientFactors : [];
  if (patientFactors.length === 0) return null;
  if (!patientFactors.every((field) => typeof field === 'string' && allowedFields.has(field))) {
    return null;
  }

  return {
    title: item.title.trim(),
    rationale: item.rationale.trim(),
    applicability: item.applicability,
    patientFactors: [...patientFactors],
    citations: citations as AnswerCitationResponseDto[],
  };
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isApplicability(value: unknown): value is GuidanceApplicability {
  return (
    typeof value === 'string' && (GUIDANCE_APPLICABILITIES as readonly string[]).includes(value)
  );
}
