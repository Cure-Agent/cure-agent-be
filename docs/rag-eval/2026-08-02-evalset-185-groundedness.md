# groundedness 평가 (생성 축)

- promptVersion: `qa-v4`
- 심판: `gpt-5.4-mini`
- 채점 문항(answerable): 185

## verdict 분포

| verdict | 문항 | 비율 |
| --- | --- | --- |
| grounded | 141 | 76.2% |
| partial | 44 | 23.8% |
| ungrounded | 0 | 0.0% |

## 주장 단위

| 축 | 수 | 비율 |
| --- | --- | --- |
| 전체 주장 | 645 | — |
| supported | 587 | 91.0% |
| miscited | 20 | 3.1% |
| unsupported | 35 | 5.4% |

**miscited가 안전 최우선 축이다** — 마커가 달려 사용자에게는 검증된 것처럼 보이는데 근거가 그 주장을 뒷받침하지 않는다. unsupported는 할루시네이션 축이고, 면책·한계 고지는 qa-v3 규칙 준수라 루브릭이 주장에서 제외한다.

## 기계 검사 (qa-v3 규칙)

| 항목 | 수 |
| --- | --- |
| 마크다운 위반 (규칙 6) | 0 |
| 마커 미사용 답변 (규칙 2) | 0 |

## 결함 문항 (partial·ungrounded) — 44건

| 문항 | verdict | miscited | unsupported | 무근거 주장 예시 |
| --- | --- | --- | --- | --- |
| evalgen-answerable-002 | partial | 1 | 0 | — |
| evalgen-answerable-012 | partial | 0 | 1 | 임상에서는 변증에 따라 선택을 고려하는 것으로 제시됩니다 [1]. |
| evalgen-answerable-024 | partial | 2 | 0 | — |
| evalgen-answerable-028 | partial | 1 | 0 | — |
| evalgen-answerable-029 | partial | 0 | 1 | 침 치료는 급성기에는 매일 시행할 수 있고, 이후 경과에 따라 횟수를 조절할 수 있습니다 [1][2]. |
| evalgen-answerable-034 | partial | 0 | 1 | 의료진이 참고할 때는 개별 한약은 변증에 따라 선택하도록 되어 있습니다. |
| evalgen-answerable-037 | partial | 1 | 0 | — |
| evalgen-answerable-044 | partial | 0 | 4 | 근거가 변증의 큰 방향은 제시하지만, 개별 환자에서 실제로 어떤 변증을 확정할지는 진료 정보가 더 필요합니다. / 즉, 실제 진료에서는 신·간·심·비의 병위와 음허·기체·혈허의 병성을 함께 보고, 여러 변증이 겹칠 수 있다는 점을 염두에 두는 방향이 근거에 맞습니다 [1][2][3]. |
| evalgen-answerable-053 | partial | 0 | 1 | 두 목표를 함께 볼 때는 공통으로 제시된 신문, 교감, 피질하를 우선 고려하는 해석이 가능합니다. |
| evalgen-answerable-058 | partial | 0 | 1 | 쌍화탕과 십전대보탕도 주요 증상개선을 위해 전문가 합의에 근거해 권고되어 있습니다. |
| evalgen-answerable-059 | partial | 0 | 1 | 권고등급은 C로 제시되어 있어, 강한 권고라기보다 참고하여 고려하는 수준입니다 [1]. |
| evalgen-answerable-064 | partial | 1 | 0 | — |
| evalgen-answerable-069 | partial | 0 | 2 | 초기 환자에서는 혈해(SP10), 양구(ST34), 위중(BL40), 슬관(LR7), 족삼리(ST36) 등의 무릎주위 경혈과 두침(감각영역, GV20, GV24), 이침, 슬관절 주변 근육의 통증유발점에 침치료를 시행할 수 있습니다. / 전침치료도 재활기 환자에서 족양명위경, 족태음비경, 족태양방광경, 족소양담경 등의 근위부·원위부 경혈 및 아시혈에 시행할 수 있습니다. |
| evalgen-answerable-074 | partial | 0 | 1 | 따라서 “더 도움이 된다”고 단정하기보다는, 참고 정보로서 전침을 고려할 수 있다고 해석하는 것이 적절합니다 [1][3][4]. |
| evalgen-answerable-077 | partial | 0 | 1 | 따라서 제공된 근거만 보면, 양약만 쓰는 것보다 소요산을 기본 처방으로 고려하는 것이 더 적절하다고 볼 수 있습니다 [1][5]. |
| evalgen-answerable-078 | partial | 0 | 1 | 또한 치료효과와 예후판정을 위해 소증 및 현증의 중증도와 호전도를 평가하도록 권고하고 있습니다 [1][4] |
| evalgen-answerable-079 | partial | 1 | 1 | 다만 근거에 나온 한약 권고는 중풍의 인지장애나 전반적 증상 개선, 혈관성 치매 및 경도인지장애에서의 보양환오탕가감과 병행치료, 그리고 중풍 환자 전반적 증상 개선을 위한 여러 처방들입니다 [1][2][3][4][5]. / 이 질문에 맞는 체질한약 우선순위를 정하려면 소음인 망양병 관련 별도 근거가 필요합니다. |
| evalgen-answerable-081 | partial | 0 | 2 | 참고로 식적증에서는 통상적 의과 치료보다 건비환을 투여할 것을 고려해야 하며 [2], / 통상적 의과 치료를 받는 식적증 식욕부진 소아에서는 향귤환 병행 치료를 고려할 수 있습니다 [4]. |
| evalgen-answerable-083 | partial | 1 | 0 | — |
| evalgen-answerable-087 | partial | 1 | 0 | — |
| evalgen-answerable-088 | partial | 0 | 1 | 정리하면, 근거상 추나치료는 단독으로도, 보조기와 병행하는 형태로도, 보조기에 다른 한의치료를 더한 복합치료의 일부로도 고려할 수 있습니다 [1][2][3][4][5]. |
| evalgen-answerable-095 | partial | 0 | 1 | 또한 침 치료는 시행하는 것을 고려해야 합니다 [1][2]. |
| evalgen-answerable-101 | partial | 1 | 0 | — |
| evalgen-answerable-105 | partial | 0 | 1 | 목과 단미 한약도 비타민 B6의 대안으로 고려할 수 있으며, 증상이 위중하지 않고 약물치료에 거부감이 있는 경우 우선적으로 고려할 수 있습니다 [2][3]. |
| evalgen-answerable-111 | partial | 1 | 0 | — |
| evalgen-answerable-113 | partial | 0 | 1 | 유침은 2-30분이 적절하다고 제시되어 있습니다[1]. |
| evalgen-answerable-119 | partial | 1 | 0 | — |
| evalgen-answerable-124 | partial | 0 | 1 | 국소 치료 시 포진이 터져 삼출물이 배액될 수 있어 감염에 주의해야 합니다 |
| evalgen-answerable-132 | partial | 0 | 1 | 근거상 산후신통과 산후 감각장애에는 온경탕, 소속명탕, 황기계지오물탕가감, 산후비방의 활용도 고려할 수 있습니다 [2]. |
| evalgen-answerable-135 | partial | 1 | 1 | 한 연구에서는 월경 3주기 동안 월경 전 침치료를 시행했을 때 월경통이 발생한 후 침치료를 시행한 경우와 비교해 지표가 더 좋지 않았고 / 침치료는 십칠추(EX-B8)에 시행하였습니다 |
| evalgen-answerable-138 | partial | 0 | 1 | 또한 측두부 두통에서는 외관(TE5)과 족임읍(GB41)도 사용할 수 있습니다 [2]. |
| evalgen-answerable-150 | partial | 0 | 1 | 또한 급성 발목 염좌의 초기 평가의 한 부분으로 MRI를 반드시 시행해야 한다는 근거는 제시되어 있지 않습니다 [1]. |
| evalgen-answerable-154 | partial | 0 | 2 | 오심번열에 대한 추가 혈자리는 제공된 근거에 직접 제시되어 있지 않습니다. / 안면홍조가 심할 때는 백회(GV20), 단중(CV17), 관원(CV4), 합곡(LI4), 곡지(LI11), 소부(HT8), 내관(PC6), 신문(HT7), 삼음교(SP6), 족삼리(ST36), 태계(KI3) 등의 경혈을 고려할 수 있습니다 [4]. |
| evalgen-answerable-160 | partial | 0 | 1 | 따라서 “금연 성공률, 치료 반응, 정신심리 지표를 높인다”는 표현은 근거상 일관되게 강하게 지지되지는 않으며, 참고 수준으로 판단하는 것이 맞습니다[5]. |
| evalgen-answerable-166 | partial | 1 | 0 | — |
| evalgen-answerable-167 | partial | 1 | 0 | — |
| evalgen-answerable-169 | partial | 0 | 2 | 항치매약물보다 한약을 더 선호하는 경우 육미지황탕을 “우선”으로 선택하라는 직접 근거는 부족합니다. / 한약 선호가 뚜렷한 알츠하이머 치매 환자에서 육미지황탕을 고려할 수는 있지만, “우선” 선택 여부는 환자 상태와 임상의 판단을 함께 반영해 결정하는 것이 적절합니다. |
| evalgen-answerable-172 | partial | 1 | 0 | — |
| evalgen-answerable-173 | partial | 0 | 1 | 근거에 따르면 삶의 질 평가는 QLQ-C30과 GQOLI-74가 활용되었고, 폐 기능 평가는 폐기능검사를 활용할 수 있습니다 [1][2][3][4][5]. |
| evalgen-answerable-178 | partial | 0 | 1 | 근거가 부족한 부분은, 이 지침이 세부 변증을 어떻게 나눌지에 대한 구체적 진단 기준까지는 제시하지 않는다는 점입니다. |
| evalgen-answerable-181 | partial | 0 | 1 | 임상 적용 시에는 환자 체형에 따른 안전성을 고려해 협척(EX-B2)에 45~90mm까지 또는 뼈에 닿는 깊이까지 자침하는 방식을 활용할 수 있습니다 [1]. |
| evalgen-answerable-184 | partial | 1 | 0 | — |
| evalgen-answerable-188 | partial | 1 | 0 | — |
| evalgen-answerable-191 | partial | 1 | 0 | — |

## 실패 문항 (생성·채점) — 0건

없음.

