# groundedness 평가 (생성 축)

- promptVersion: `qa-v4`
- 심판: `gpt-5.4-mini`
- 채점 문항(answerable): 59

## verdict 분포

| verdict | 문항 | 비율 |
| --- | --- | --- |
| grounded | 48 | 81.4% |
| partial | 11 | 18.6% |
| ungrounded | 0 | 0.0% |

## 주장 단위

| 축 | 수 | 비율 |
| --- | --- | --- |
| 전체 주장 | 245 | — |
| supported | 229 | 93.5% |
| miscited | 8 | 3.3% |
| unsupported | 8 | 3.3% |

**miscited가 안전 최우선 축이다** — 마커가 달려 사용자에게는 검증된 것처럼 보이는데 근거가 그 주장을 뒷받침하지 않는다. unsupported는 할루시네이션 축이고, 면책·한계 고지는 qa-v3 규칙 준수라 루브릭이 주장에서 제외한다.

## 기계 검사 (qa-v3 규칙)

| 항목 | 수 |
| --- | --- |
| 마크다운 위반 (규칙 6) | 0 |
| 마커 미사용 답변 (규칙 2) | 0 |

## 결함 문항 (partial·ungrounded) — 11건

| 문항 | verdict | miscited | unsupported | 무근거 주장 예시 |
| --- | --- | --- | --- | --- |
| evalgen-answerable-007 | partial | 0 | 1 | 근거상 초진에서는 소증과 현증의 구체적 진단도구로 사상체질소증 진단기준과 사상체질병증 진단기준, 중증도 평가기준과 호전도 평가기준을 참고하도록 제시되어 있습니다 [1][3][4]. |
| evalgen-answerable-009 | partial | 1 | 0 | — |
| evalgen-answerable-011 | partial | 1 | 0 | — |
| evalgen-answerable-014 | partial | 0 | 1 | 한약 치료의 효과를 보기 위해서는 2개월 이상 치료가 필요하다고 제시되어 있습니다 [1]. |
| evalgen-answerable-017 | partial | 2 | 1 | 따라서 참고로는 한약치료를 약물치료와 비교해 고려할 수 있으나, 우선 적용 여부는 임상 상황과 의료인의 판단이 필요합니다. |
| evalgen-answerable-025 | partial | 0 | 2 | 중기에 대해서는 제공된 근거에서 구체적 치료목표가 직접 제시되지는 않았습니다. / 따라서 실제 진료에서는 환자 상태, 통증, 기능, 회복 단계, 동반 증상을 함께 보면서 단계별로 목표를 정하는 방식이 적절하겠습니다 [1][3][4]. |
| evalgen-answerable-031 | partial | 1 | 0 | — |
| evalgen-answerable-036 | partial | 0 | 1 | 편두통 환자에게는 의료인이 개별 상황에 맞춰 참고하는 것이 적절합니다. |
| evalgen-answerable-037 | partial | 1 | 1 | 근거가 충분합니다. |
| evalgen-answerable-051 | partial | 1 | 1 | 실제 적용은 환자 상태와 변증, 임상 경험을 함께 고려해 의료인이 판단하는 참고 정보로 보는 것이 적절합니다 [2]. |
| evalgen-answerable-062 | partial | 1 | 0 | — |

## 실패 문항 (생성·채점) — 0건

없음.

