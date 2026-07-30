/**
 * docs/specs/23 잔여 템플릿과 원문 결함 면제를 모방한 합성 fixture.
 *
 * 실제 지침의 문장·질환·처방을 옮기지 않고, 판정에 필요한 구조만 재현한다.
 * 모든 페이지 문자열의 첫 줄은 인쇄 페이지 번호다.
 */

export const consensusRecommendationPages: string[] = [
  `90
IV 권고사항
1 한의 단독 치료
1) 별씨 식사법
【 R20 】 작은별 식욕 저하에는 별씨 간식을 나누어 먹는 방식을
합의를 통해 권고한다.
임상적 고려사항
불편감이 생기면 제공 횟수를 줄인다.
(1) 배경
별씨 식사법은 가상의 식사 편안함 지표를 높였다.
【 R21 】
밤안개성 갈증에는 구름샘 음료를 소량 제공하도록 합의를 통해 권고한다.
임상적 고려사항
차가움을 느끼면 음료 온도를 높인다.
(1) 배경
구름샘 음료는 가상의 갈증 지표를 낮췄다.`,
];

export const unsupportedRecitationPages: string[] = [
  `100
IV 권고사항
1 한의 단독 치료
1) 유성 온열법
【 R1 】
권고안 권고등급/근거수준 참고문헌
유성 긴장이 있으면 별무리 온열법을 적용할 것을 권고한다. A/High
임상적 고려사항
열감이 있으면 시간을 줄인다.
(1) 배경
별무리 온열법은 가상의 이완 지표를 높였다.
결과요약표
【 R1 】
앞선 번호는 결과 비교를 위해 다시 표시했다.`,
];

export const postSubsectionReferencePages: string[] = [
  `110
IV 권고사항
1 한의 단독 치료
1) 은하 호흡법
【 R3 】
권고안 권고등급/근거수준 참고문헌
은하성 답답함에는 고리별 호흡법을 고려한다. B/Moderate
임상적 고려사항
어지러우면 잠시 쉰다.
(1) 배경
고리별 호흡법은 가상의 편안함 지표를 높였다.
【 R88 】
이 번호는 근거 서술에서 비교 대상으로만 인용했다.`,
];

export const preSubsectionMissingPages: string[] = [
  `111
IV 권고사항
1 한의 단독 치료
1) 새벽 종소리법
【 R4 】
권고안 권고등급/근거수준 참고문헌
새벽성 긴장이 있으면 종소리 이완법을 고려한다. B/Low
임상적 고려사항
소리가 불편하면 음량을 낮춘다.
【 R89 】
이 번호에는 권고 표와 등급이 빠져 있다.
(1) 배경
종소리 이완법은 가상의 긴장 지표를 낮췄다.
【 R90 】
이 번호는 근거 서술에서 비교 대상으로만 인용했다.`,
];

export const bracketedReferenceResetPages: string[] = [
  `112
IV 권고사항
1 한의 단독 치료
1) 별무리 수면법
【 R12 】
권고안 권고등급/근거수준 참고문헌
별무리 불면에는 달구름 수면법을 고려한다. B/Moderate
임상적 고려사항
어지러우면 적용을 멈춘다.
(1) 배경
달구름 수면법은 가상의 수면 지표를 높였다.
【 R91 】
이 번호는 근거 서술에서 비교 대상으로만 인용했다.
[참고문헌]
Imaginary Moon-Cloud Sleep Review
【 R92 】
이 번호에는 권고 표와 등급이 빠져 있다.`,
];

export const numberedReferenceResetPages: string[] = [
  `113
IV 권고사항
1 한의 단독 치료
1) 햇무리 온기법
【 R13 】
권고안 권고등급/근거수준 참고문헌
햇무리 냉감에는 잔별 온기법을 고려한다. B/Low
임상적 고려사항
열감이 생기면 적용 시간을 줄인다.
(1) 배경
잔별 온기법은 가상의 온기 지표를 높였다.
【 R93 】
이 번호는 근거 서술에서 비교 대상으로만 인용했다.
(3) 참고문헌
Invented Little-Star Warming Trial
【 R94 】
이 번호에는 권고 표와 등급이 빠져 있다.`,
];

export const hyphenatedRecommendationPages: string[] = [
  `120
IV 권고사항
1 한의 단독 치료
1) 구름빛 산책법
【 R5-1 】
권고안 권고등급/근거수준 참고문헌
구름빛 피로가 남으면 짧은 별길 산책을 고려한다. B/Moderate
임상적 고려사항
숨이 차면 산책 시간을 줄인다.
(1) 배경
별길 산책은 가상의 활력 지표를 높였다.`,
];

export const extendedGradeVocabularyPages: string[] = [
  `130
IV 권고사항
1 한의 단독 치료
1) 수정빛 관찰법
【 R6 】
권고안 권고등급/근거수준 참고문헌
수정빛 피로에는 달그늘 관찰법의 사용 여부를 판단할 수 없다. Inconclusive
임상적 고려사항
눈부심이 있으면 관찰을 멈춘다.
【 R7 】
권고안 권고등급/근거수준 참고문헌
푸른별 냉감에는 온별 주머니를 짧게 적용하도록 권고한다. Insufficient/GPP
임상적 고려사항
열감이 생기면 즉시 제거한다.
【 R8 】
권고안 권고등급/근거수준 참고문헌
잔구름 긴장에는 종이별 이완법을 적용하도록 권고한다. GPP/Insufficient
임상적 고려사항
통증이 생기면 동작을 멈춘다.`,
];

export const dottedGradePages: string[] = [
  `140
IV 권고사항
1 한의 단독 치료
1) 별가루 이완법
【 R9 】
권고안 권고등급/근거수준 참고문헌
별가루 긴장에는 은빛 이완법을 고려한다. C./Very Low
임상적 고려사항
불편하면 동작 범위를 줄인다.
【 R10 】
권고안 권고등급/근거수준 참고문헌
달가루 긴장에는 구름 이완법을 고려한다. C/Very Low
임상적 고려사항
어지러우면 동작을 멈춘다.`,
];

export const unknownEvidenceLevelPages: string[] = [
  `150
IV 권고사항
1 한의 단독 치료
1) 유리달 호흡법
【 R11 】
권고안 권고등급/근거수준 참고문헌
유리달 답답함에는 잔별 호흡법을 고려한다. C/Vey Low
임상적 고려사항
숨이 차면 즉시 쉰다.
(1) 배경
잔별 호흡법은 가상의 편안함 지표를 높였다.`,
];

export const knownDefectIdentitySample = {
  sourceSystem: 'NCKM-SYNTHETIC',
  externalId: 'residual-fixture-document',
  version: '2026-07',
};

export const makeKnownDefectDiagnosticsSample = () => ({
  uniqueNumbers: ['R7', 'R8', 'R20', 'R21', 'R30', 'R31'],
  missing: ['R7', 'R8'],
  duplicated: ['R20', 'R21'],
  gradeMissing: ['R30'],
  unknownEvidenceLevels: [
    { recommendationNumber: 'R31', raw: 'Vey Low' },
  ],
});
