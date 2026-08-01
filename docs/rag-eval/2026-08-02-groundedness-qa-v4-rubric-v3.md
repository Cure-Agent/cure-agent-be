# groundedness 평가 (생성 축)

- promptVersion: `qa-v4`
- 심판: `gpt-5.4-mini`
- 채점 문항(answerable): 59

## verdict 분포

| verdict | 문항 | 비율 |
| --- | --- | --- |
| grounded | 46 | 78.0% |
| partial | 13 | 22.0% |
| ungrounded | 0 | 0.0% |

## 주장 단위

| 축 | 수 | 비율 |
| --- | --- | --- |
| 전체 주장 | 239 | — |
| supported | 221 | 92.5% |
| miscited | 7 | 2.9% |
| unsupported | 11 | 4.6% |

**miscited가 안전 최우선 축이다** — 마커가 달려 사용자에게는 검증된 것처럼 보이는데 근거가 그 주장을 뒷받침하지 않는다. unsupported는 할루시네이션 축이고, 면책·한계 고지는 qa-v3 규칙 준수라 루브릭이 주장에서 제외한다.

## 기계 검사 (qa-v3 규칙)

| 항목 | 수 |
| --- | --- |
| 마크다운 위반 (규칙 6) | 0 |
| 마커 미사용 답변 (규칙 2) | 0 |

## 결함 문항 (partial·ungrounded) — 13건

| 문항 | verdict | miscited | unsupported | 무근거 주장 예시 |
| --- | --- | --- | --- | --- |
| evalgen-answerable-002 | partial | 0 | 1 | 다만 근거 수준은 낮음으로 평가된 비교연구도 포함되어 있어, 실제 적용은 환자 상태를 함께 고려해야 합니다 [4]. |
| evalgen-answerable-005 | partial | 0 | 1 | 다른 근거에서는 대릉(PC7), 내관(PC6), 합곡(LI4), 양계(LI5), 곡지(LI11), 수삼리(LI10), 어제(LU10), 노궁(PC8) 등을 사용한 예가 제시되어 있습니다 [3]. |
| evalgen-answerable-007 | partial | 0 | 2 | 초진에서는 환자의 현재 주증을 바탕으로 현증 여부를 먼저 확인하고 / 최종적으로는 현증을 우선해 진단하고 소증은 치료법 선택과 중증도 판단에 반영하는 방식으로 이해하시면 됩니다 |
| evalgen-answerable-009 | partial | 0 | 1 | 질문은 “적절한가”이지만, 제공된 근거는 두 척도를 사용해도 된다는 권고 수준의 내용까지만 제시하며, 어느 하나가 더 우월한지까지는 직접 말하지 않습니다. |
| evalgen-answerable-011 | partial | 0 | 1 | 한약치료의 주요 처방으로는 통륭계폐탕, 진무탕, 오령산, 통관탕이 제시되어 있습니다 [5]. |
| evalgen-answerable-017 | partial | 2 | 0 | — |
| evalgen-answerable-024 | partial | 1 | 0 | — |
| evalgen-answerable-025 | partial | 0 | 2 | 구체적으로는 수술후 초기·중기·재활기 각 단계별로 적절한 치료목표를 설정해 치료하는 것이 필요하다고 제시되어 있습니다. / 따라서 이 근거만으로 정리하면, 단계별 목표 설정과 평가를 하되 공통 목표는 치유·감염관리·통증완화·관절기능 회복으로 두고, 각 시점의 환자 상태에 맞춰 치료계획을 조정하는 방식이 타당합니다. |
| evalgen-answerable-036 | partial | 0 | 1 | 전침치료는 1회 30분, 1일 1회, 총 30일 정도로 이루어진 사례가 있습니다 [1]. |
| evalgen-answerable-037 | partial | 1 | 0 | — |
| evalgen-answerable-051 | partial | 1 | 0 | — |
| evalgen-answerable-053 | partial | 1 | 1 | 두 목적을 함께 고려할 때는 두 목록에서 공통으로 제시된 신문, 교감, 피질하를 우선 고려할 수 있습니다. |
| evalgen-answerable-058 | partial | 1 | 1 | 쌍화탕과 십전대보탕은 주요 증상개선을 위해 전문가 그룹의 합의에 근거하여 권고합니다 [2][3]. |

## 실패 문항 (생성·채점) — 0건

없음.

