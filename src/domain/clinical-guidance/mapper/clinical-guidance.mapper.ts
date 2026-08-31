import { SupportedLang } from '../../../infrastructure/llm/translation/translator.port';
import { ClinicalGuidanceResponseDto } from '../dto/response/clinical-guidance.response.dto';
import { ClinicalGuidanceRow, SafetyAlertJson } from '../persistence/clinical-guidance.schema';

/**
 * 알레르기 안전 경고 문구표 (docs/specs/44) — `ABSTAIN_REASON_MESSAGE`(§43)와 같은 자리다.
 *
 * **매퍼가 소유한다**: 사유(알레르기명)는 행에 저장되고 문장은 직렬화 시점에 만들어지므로,
 * 문구표는 그 렌더가 일어나는 곳에 있어야 한다. 조립 시점의 composer도 같은 표를 읽어
 * 스트림 직후의 문장과 재조회의 문장이 갈릴 수 없다.
 *
 * 알레르기명 자체는 **번역하지 않는다** — 의료인이 입력한 환자 데이터이고, 오역이 임상
 * 정보를 바꾼다(스펙 Out of scope). 우리가 소유하는 것은 그것을 감싸는 정형구뿐이다.
 */
export const SAFETY_ALERT_MESSAGE: Record<SupportedLang, (allergen: string) => string> = {
  ko: (allergen) =>
    `환자에게 ${allergen} 알레르기 병력이 있습니다. 관련 계열 약물 권고 적용 전 교차 반응 여부를 확인하세요.`,
  en: (allergen) =>
    `The patient has a documented ${allergen} allergy. Check for cross-reactivity before applying recommendations for related drug classes.`,
};

export function renderSafetyAlert(allergen: string, responseLang: SupportedLang): string {
  return SAFETY_ALERT_MESSAGE[responseLang](allergen);
}

/**
 * 저장된 안전 경고를 렌더 언어로 다시 만든다 (docs/specs/44).
 *
 * `allergen`이 없는 **과거 행은 저장된 문장이 그대로 나간다** — 키 부재로 닫는 §42의 규율이며,
 * 이 스텝 이전에 만들어진 참고안은 렌더의 재료를 갖고 있지 않다.
 */
function renderSafetyAlerts(
  alerts: SafetyAlertJson[],
  responseLang: SupportedLang,
): SafetyAlertJson[] {
  return alerts.map((alert) => {
    // `allergen`은 렌더의 재료이지 계약이 아니다 — 응답 DTO에는 실리지 않는다
    const { allergen, ...rest } = alert;
    if (!allergen) return rest;
    return { ...rest, description: renderSafetyAlert(allergen, responseLang) };
  });
}

/**
 * @param responseLang 이 참고안을 **렌더할** 언어 (docs/specs/44) — 요청이 아니라 그 참고안이
 *   매인 메시지의 `messages.response_lang`이다. 참고안은 `message_id` FK로 메시지에 1:1로
 *   매이므로 §42가 만든 축이 이미 닿는다(§43이 기권 사유에 딛고 선 것과 같은 자리).
 *
 *   `considerations`는 구조화·폴백 모두 생성 시점에 굳어 있어 그대로 나가고, 여기서 언어를
 *   쓰는 것은 **안전 경고**뿐이다 — 알레르기명을 감싸는 문장이 본문과 다른 언어로 서면
 *   한 카드 안에서 갈린다(「왜 절반만 바뀌냐」가 버그로 올라온다).
 */
export function toClinicalGuidanceDto(
  row: ClinicalGuidanceRow,
  responseLang: SupportedLang,
): ClinicalGuidanceResponseDto {
  return {
    id: row.id,
    patientId: row.patientId,
    patientProfileSnapshotId: row.patientSnapshotId,
    summary: row.summary,
    considerations: row.considerations,
    safetyAlerts: renderSafetyAlerts(row.safetyAlerts, responseLang),
    missingInformation: row.missingInformation,
    reviewStatus: row.reviewStatus,
    generatedAt: row.createdAt.toISOString(),
  };
}
