import { SupportedLang } from '../../../infrastructure/llm/translation/translator.port';
import { ClinicalGuidanceResponseDto } from '../dto/response/clinical-guidance.response.dto';
import { ClinicalGuidanceRow } from '../persistence/clinical-guidance.schema';

/**
 * @param responseLang 이 참고안을 **렌더할** 언어 (docs/specs/44) — 요청이 아니라 그 참고안이
 *   매인 메시지의 `messages.response_lang`이다. 참고안은 `message_id` FK로 메시지에 1:1로
 *   매이므로 §42가 만든 축이 이미 닿는다(§43이 기권 사유에 딛고 선 것과 같은 자리).
 *
 *   `considerations`는 생성 시점에 굳어 있어 그대로 나가고, 여기서 언어를 쓰는 것은 **안전
 *   경고**뿐이다 — 알레르기명을 감싸는 문장이 본문과 다른 언어로 서면 한 카드 안에서 갈린다.
 */
export function toClinicalGuidanceDto(
  row: ClinicalGuidanceRow,
  responseLang: SupportedLang,
): ClinicalGuidanceResponseDto {
  void responseLang; // 스텁 — 안전 경고 렌더는 구현 단계에서
  return {
    id: row.id,
    patientId: row.patientId,
    patientProfileSnapshotId: row.patientSnapshotId,
    summary: row.summary,
    considerations: row.considerations,
    safetyAlerts: row.safetyAlerts,
    missingInformation: row.missingInformation,
    reviewStatus: row.reviewStatus,
    generatedAt: row.createdAt.toISOString(),
  };
}
