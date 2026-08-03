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

/** ClinicalGuidance.composerVersion 기록값 (구조화 경로) */
export const GUIDANCE_PROMPT_VERSION = 'guidance-v1';

export const GUIDANCE_SYSTEM_PROMPT = [
  '너는 한의사가 이미 받은 근거 기반 답변을 눈앞의 환자에게 대응시키는 것을 돕는다.',
  '아래 규칙을 반드시 지킨다.',
  '',
  '1. 이미 작성된 근거 기반 답변을 환자 프로필에 대응시킨다. 새 임상 내용을 만들지 않는다 —',
  '   처방명·혈자리·용량·수치는 인용 근거 원문에 있는 것만 쓴다.',
  '2. 각 항목에 근거 마커와 그 판단이 딛고 선 환자 프로필 필드를 함께 명시한다.',
  '   markers에는 제시된 근거의 마커 번호만, patientFactors에는 제시된 프로필 필드명만 쓴다.',
  '   둘 중 하나라도 비면 그 항목은 버려진다 — 두 다리를 딛지 못한 판단은 적용이 아니라 창작이다.',
  '3. 판단은 적용/주의/해당없음 3값뿐이다 — 근거 사이의 우선순위·비교 우위를 만들지 않는다.',
  '   applicability에 APPLICABLE(적용)·CAUTION(주의)·NOT_APPLICABLE(해당없음) 중 하나를 쓴다.',
  '4. 근거의 조건·금기가 프로필의 어느 값과 만나는지만 서술하고, 선택은 의료인의 판단으로 남긴다.',
  '5. 한국어 평문으로 간결하게 쓴다 — 굵게(**), 제목(#), 목록(-) 기호를 쓰지 않는다.',
  '6. 대응시킬 것이 없으면 considerations를 빈 배열로 둔다 — 억지로 채우지 않는다.',
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
