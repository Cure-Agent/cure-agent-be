# groundedness 평가 (생성 축)

- promptVersion: `qa-v3`
- 심판: `gpt-5.4-mini`
- 채점 문항(answerable): 59

## verdict 분포

| verdict | 문항 | 비율 |
| --- | --- | --- |
| grounded | 47 | 79.7% |
| partial | 12 | 20.3% |
| ungrounded | 0 | 0.0% |

## 주장 단위

| 축 | 수 | 비율 |
| --- | --- | --- |
| 전체 주장 | 244 | — |
| supported | 223 | 91.4% |
| miscited | 12 | 4.9% |
| unsupported | 7 | 2.9% |

**miscited가 안전 최우선 축이다** — 마커가 달려 사용자에게는 검증된 것처럼 보이는데 근거가 그 주장을 뒷받침하지 않는다. unsupported는 할루시네이션 축이고, 면책·한계 고지는 qa-v3 규칙 준수라 루브릭이 주장에서 제외한다.

## 기계 검사 (qa-v3 규칙)

| 항목 | 수 |
| --- | --- |
| 마크다운 위반 (규칙 6) | 0 |
| 마커 미사용 답변 (규칙 2) | 0 |

## 결함 문항 (partial·ungrounded) — 12건

| 문항 | verdict | miscited | unsupported | 무근거 주장 예시 |
| --- | --- | --- | --- | --- |
| evalgen-answerable-003 | partial | 2 | 1 | 수술 후 초기·중기·재활기 모두에서 공통적으로 통증, 관절가동범위, 근력, 기능회복을 평가·계획의 핵심으로 두고 |
| evalgen-answerable-011 | partial | 2 | 1 | 따라서 제공된 근거만으로는 특정 한방치료 하나를 단정하기보다, 한약치료(오령산, 통륭계폐탕, 통관탕)와 뜸치료를 우선 고려할 수 있다고 답하는 것이 적절합니다 [1][2][3][4][5]. |
| evalgen-answerable-024 | partial | 3 | 0 | — |
| evalgen-answerable-025 | partial | 0 | 1 | 수술 후 중기와 재활기에도 수술 후 통증의 완화와 어깨 관절 기능 회복, 즉 관절가동범위와 근력 회복을 중심으로 평가하고 치료계획을 세우는 것이 적절합니다 [1]. |
| evalgen-answerable-029 | partial | 1 | 0 | — |
| evalgen-answerable-031 | partial | 1 | 0 | — |
| evalgen-answerable-037 | partial | 1 | 0 | — |
| evalgen-answerable-039 | partial | 0 | 1 | 제공된 근거에서는 퇴행성 슬관절염 환자에서 침 치료가 통상적(의과) 치료보다 통증 감소와 기능 개선, 삶의 질 개선 및 증상 호전에 유의한 효과가 있어 임상진료 시 시행을 고려해야 한다고 제시합니다 [2]. |
| evalgen-answerable-041 | partial | 0 | 1 | 포함된 연구에서는 정영(GB17), 백회(GV20), 태양(EX-HN5), 신정(GV24), 합곡(LI4), 삼음교(SP6), 태충(LR3)도 활용되었습니다 |
| evalgen-answerable-058 | partial | 0 | 2 | 병행치료로는 귀비탕을 한방치료(전침/뜸)에 추가로 병행하여 사용하는 것을 고려할 수 있고 [5], 암성 피로에서는 한약 치료와 일상관리를 병행하는 것이 제시되어 있습니다 [1]. / 따라서 근거상으로는 만성피로증후군이나 특발성 만성 피로에서 일부 한약의 단독 사용은 고려할 수 있으나, 질문에 적은 모든 병행요법을 일반적으로 권고한다고 보기는 어렵습니다 [2][3][4][5]. |
| evalgen-answerable-059 | partial | 1 | 0 | — |
| evalgen-answerable-063 | partial | 1 | 0 | — |

## 실패 문항 (생성·채점) — 0건

없음.

