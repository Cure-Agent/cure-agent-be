/**
 * 참고안 구조화 프롬프트 (docs/specs/33).
 * qa-v5(prompt-builder.ts)와 **분리된 축**이다 — QA 근거 계약·groundedness 전후 비교를
 * 오염시키지 않으려면 버전도 관측도 따로 서야 한다.
 *
 * 적용 판단 3값의 **집행 지점은 여기가 아니라 도메인 검증기**다(§7 GUIDANCE_APPLICABILITIES).
 * 프롬프트는 모델에게 주는 텍스트일 뿐이라 어긋난 값이 오면 그 항목이 폐기될 뿐이고,
 * 어휘가 갈라지면 폴백률이 즉시 튀어 관측에 잡힌다.
 */
import { GuidanceStructureInput } from './guidance-structurer.port';
import { SupportedLang } from '../translation/translator.port';

/**
 * ClinicalGuidance.composerVersion 기록값 (구조화 경로).
 * v1 → v2: 1차 측정(docs/rag-eval/2026-08-03-guidance-v1.md)의 두 결함 패턴을 규칙으로 막는다 —
 * ⑴ 출생연도로 나이를 계산해 근거의 연령 조건 충족을 단정한 오독 1건 ⑵ 무관함을 말하려고
 * 필드를 인용하는 「빈 다리」 패턴(6건). 둘 다 검증기가 못 잡는 축이라 프롬프트가 막아야 한다.
 */
export const GUIDANCE_PROMPT_VERSION = 'guidance-v2';

/**
 * 참고안 언어별 기록값 (docs/specs/44) — `promptVersionFor`(답변)와 같은 모양이다.
 *
 * **버전을 가르는 이유는 측정 대상이 갈리기 때문이다**: 영문 경로는 규칙 7이 다르고 용어집이
 * 함께 실리므로, 같은 이름으로 기록하면 폴백률 실측이 두 프롬프트를 섞어 잰다. 한국어 경로는
 * `guidance-v2` 그대로라 기존 관측이 유효하게 남는다(기준 2).
 */
export function guidancePromptVersionFor(responseLang: SupportedLang): string {
  void responseLang; // 스텁 — 언어 분기는 구현 단계에서
  return GUIDANCE_PROMPT_VERSION;
}

/** 언어별 시스템 프롬프트 (docs/specs/44) — 규칙 7이 갈리고 영문에는 용어집이 실린다 */
export function guidanceSystemPromptFor(responseLang: SupportedLang): string {
  void responseLang; // 스텁 — 언어 분기는 구현 단계에서
  return GUIDANCE_SYSTEM_PROMPT;
}

export const GUIDANCE_SYSTEM_PROMPT = [
  '너는 한의사가 이미 받은 근거 기반 답변을 눈앞의 환자에게 대응시키는 것을 돕는다.',
  '아래 규칙을 반드시 지킨다.',
  '',
  '1. 이미 작성된 근거 기반 답변을 환자 프로필에 대응시킨다. 새 임상 내용을 만들지 않는다 —',
  '   처방명·혈자리·용량·수치는 인용 근거 원문에 있는 것만 쓴다.',
  '2. 각 항목에 근거 마커와 그 판단이 딛고 선 환자 프로필 필드를 함께 명시한다.',
  '   markers에는 제시된 근거의 마커 번호만, patientFactors에는 제시된 프로필 필드명만 쓴다.',
  '   둘 중 하나라도 비면 그 항목은 버려진다 — 두 다리를 딛지 못한 판단은 적용이 아니라 창작이다.',
  '3. patientFactors에는 그 판단이 실제로 딛고 선 필드만 쓴다 — 무관함을 말하려고 필드를 인용하지 않는다.',
  '   프로필의 어떤 필드로도 적용·주의·해당없음을 가릴 수 없는 근거에는 항목을 만들지 않는다.',
  '   항목 수를 채우는 것보다 비우는 쪽이 옳다.',
  '4. 판단은 적용/주의/해당없음 3값뿐이다 — 근거 사이의 우선순위·비교 우위를 만들지 않는다.',
  '   applicability에 APPLICABLE(적용)·CAUTION(주의)·NOT_APPLICABLE(해당없음) 중 하나를 쓴다.',
  '5. 나이·기간·횟수·점수 같은 수치 조건은 충족 여부를 프로필 값으로 계산해 판정하지 않는다 —',
  '   근거의 수치 조건 원문을 그대로 옮기고, 충족 여부 확인은 의료인에게 남긴다.',
  '   (예: 출생연도로 나이를 계산해 「연령 조건을 충족한다」고 쓰지 않는다.)',
  '6. 근거의 조건·금기가 프로필의 어느 값과 만나는지만 서술하고, 선택은 의료인의 판단으로 남긴다.',
  '7. 한국어 평문으로 간결하게 쓴다 — 굵게(**), 제목(#), 목록(-) 기호를 쓰지 않는다.',
  '8. 대응시킬 것이 없으면 considerations를 빈 배열로 둔다 — 억지로 채우지 않는다.',
  '',
  'JSON만 출력한다:',
  '{"considerations":[{"title":"짧은 제목","rationale":"근거와 프로필이 만나는 지점",',
  '"applicability":"APPLICABLE|CAUTION|NOT_APPLICABLE","markers":[1],"patientFactors":["진단명"]}]}',
].join('\n');

export function buildGuidanceUserPrompt(input: GuidanceStructureInput): string {
  const evidence = input.evidence
    .map(
      (item) =>
        `[${item.marker}] ${item.guidelineTitle} — ${item.sectionPath.join(' > ')}\n${item.content}`,
    )
    .join('\n\n');
  const profile = input.profileFields
    .map((field) => `- ${field.field}: ${field.value}`)
    .join('\n');

  return [
    '## 인용 근거',
    evidence,
    '',
    '## 환자 프로필',
    profile,
    '',
    '## 작성된 답변',
    input.answerText,
  ].join('\n');
}
