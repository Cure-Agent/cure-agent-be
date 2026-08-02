# 32. qa-v5 — unsupported 축 프롬프트 개선 + miscited 관측성

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 테스트로 동결되며, 구현 중 수정할 수 없다.

## 목표

증량 기준선(185문항·645주장, docs/rag-eval/2026-08-02-evalset-185-groundedness.md)이 확보한
분해능의 첫 소비처다. 최대 결함 축 **unsupported 5.4%(35건)** 를 생성 프롬프트 규칙으로
겨냥해 낮추고(qa-v4 → qa-v5), 다음 표적인 miscited의 드릴다운 관측성(주장 원문 예시)을
리포트에 확보한다. spec 30이 «개선은 이 지표의 전후 비교로 다음에»라며 미룬 그 다음이다.

## 실측 근거 (2026-08-02 증량 기준선)

| 확인 항목 | 실측 |
|---|---|
| 주장 단위 | supported 91.0% · miscited 3.1%(20) · **unsupported 5.4%(35)** |
| unsupported 지배 패턴 ① | **근거 밖 구체 임상 항목 나열** — 처방명·혈자리·수치를 일반 지식으로 보충 (069 혈위 목록·154 경혈 나열·132 처방 나열·113 유침 시간·181 자침 깊이) |
| unsupported 지배 패턴 ② | **종합 판단 생성** — 근거에 없는 우선순위·비교 우위를 접속 문장으로 창작 (077 「양약보다 소요산이 더 적절」·053 「공통 혈위 우선 고려」·074·160·169) |
| qa-v4의 역설 | 규칙 2가 종합 목록에서 마커를 빼게 하자 같은 내용이 마커 없이 남아 miscited 대신 unsupported로 이동했다 — 마커 규칙만으로는 내용 창작을 못 막는다 |
| miscited 관측성 공백 | 심판이 unsupportedExamples만 반환해 리포트의 miscited 전용 행이 전부 「—」 — 다음 사이클의 표적인데 드릴다운 원문이 없다 |

## 범위 (진입점)

**신규·변경 엔드포인트 없음.** 대화 경로는 시스템 프롬프트 텍스트만 변경.

| 진입점 | 변경 |
|---|---|
| `infrastructure/llm/prompt-builder.ts` | `PROMPT_VERSION = 'qa-v5'`. 규칙 1에 아래 원문 추가 — 규칙 2·6 번호는 기계 검사가 참조하므로 번호 체계 불변 |
| `domain/evaluation/groundedness-judge.port.ts` | `GroundednessJudgement.miscitedExamples: string[]` (최대 2 — unsupportedExamples와 동일 규약) |
| `domain/evaluation/openai-groundedness-judge.ts` | 루브릭 출력 JSON에 miscitedExamples 요구 추가. **채점 기준·비주장 예외 문구는 rubric v3 그대로** — 심판이 함께 변하면 전후 비교가 오염된다 |
| `domain/evaluation/fake-groundedness-judge.ts` | 계약 충족(`miscitedExamples: []` — miscited 항상 0과 일관) |
| `domain/evaluation/groundedness-eval.service.ts` | `FlaggedAnswer.miscitedExamples` + 과억제 감시 집계 `suppressionGuard` (분모 규약은 아래) |
| `domain/evaluation/groundedness.report.ts` | 결함 문항 표에 miscited 예시 열, 과억제 감시 절 추가 |

**qa-v5 규칙 원문** (규칙 1의 연속 행으로 추가):

```
처방명·혈자리·용량·기간·횟수 같은 구체 임상 항목은 그 항목이 실제로 적힌 근거가 있을 때만 쓴다.
근거에 없는 항목을 일반 지식으로 보충해 나열하지 않는다 — 근거에 있는 항목만 남긴다.
여러 근거를 종합해 근거 어디에도 없는 새 판단을 만들지 않는다. 우선순위·비교 판단은 근거가 직접
그렇게 서술할 때만 쓴다 (예: 「더 적절하다」「우선 고려할 수 있다」는 근거 원문에 그 취지가 있을
때만). 근거가 방향만 제시하면 방향까지만 전달하고, 선택은 규칙 4대로 의료인의 판단으로 넘긴다.
```

## Entity / 마이그레이션 변경분

없음.

## 추가 에러코드

없음 — 프롬프트·평가 계층이다.

## 측정·판정 계획 (1사이클 규약 — 2026-08-03 사용자 확정)

- qa-v5로 185문항 1회 재실행(생성·심판 `gpt-5.4-mini`·rubric v3·프로덕션 코퍼스, ~$0.9).
  리포트는 `docs/rag-eval/` 관행대로 커밋. **배포 전 측정이 채택을 게이트한다.**
- **채택**: unsupported율 5.4% 대비 **~2%p 이상 개선** 그리고 과억제 신호 없음 — 문항당
  평균 주장 수 3.5 대비 25% 이상 급감·noMarkerAnswers 급증이 없을 것.
- **중단**: 개선이 ~2%p 미만이면 qa-v6 반복 없이 종료(심판 과적합 방지). 악화·과억제면
  `PROMPT_VERSION`을 qa-v4로 롤백하고 리포트만 남긴다. 관측성 변경은 결과와 무관하게 유지.

## 수용 기준 (= 동결할 시나리오, Definition of Done)

1. `PROMPT_VERSION`이 `qa-v5`다 (유닛 — prompt-rules.spec 선례).
2. 시스템 프롬프트에 구체 임상 항목 출처 제한이 실려 있다 — 「실제로 적힌 근거가 있을 때만」·
   「일반 지식으로 보충해 나열하지 않는다」 포함 (유닛).
3. 시스템 프롬프트에 종합 판단 생성 금지가 실려 있다 — 「근거 어디에도 없는 새 판단을 만들지
   않는다」·「근거가 직접 그렇게 서술할 때만」 포함 (유닛).
4. 실물 심판 루브릭이 miscited 주장 원문 예시(최대 2)를 요구하되, rubric v3의 비주장 예외
   문구(면책·적용 지침·한계 고지·근거 상태 논평·재질의 유도)는 그대로다 (유닛 — 루브릭 텍스트 단언).
5. `normalizeJudgement`가 miscitedExamples를 unsupportedExamples와 동일 규약으로 정규화한다
   (유닛): ⑴ 누락이면 빈 배열 ⑵ 비배열이면 빈 배열 ⑶ 문자열 아닌 원소는 버린다
   ⑷ 최대 2개로 자른다.
6. 심판 판정의 miscitedExamples가 ⑴ 결함 문항(`FlaggedAnswer`)에 전파되고 ⑵ 리포트 결함 문항
   표의 해당 행에 원문으로 실린다 (주입 fake 심판 — spec 30 기준 2의 주입 선례).
7. 리포트에 과억제 감시 지표 3종이 라벨과 값으로 실린다 — fake 구성으로 결정적. **분모 규약**:
   ⑴ `avgClaimsPerAnswer` = 전체 주장 수 ÷ **채점 성공 문항 수**(소수 1자리 반올림)
   ⑵ `avgAnswerLengthChars` = 답변 길이 합 ÷ **생성 성공 문항 수**(정수 반올림)
   ⑶ `insufficiencyDisclosedCount` = `insufficiencyDisclosed`가 true인 채점 수.
   분모가 0이면 해당 값은 0이다. 두 분모를 분리하는 이유: 심판만 실패한 문항은 답변이 생성됐으므로
   길이 통계에는 들어가야 하고, 주장 수 통계에는 들어갈 수 없다.

## Out of scope

- **qa-v6 반복** — 1사이클 규약. 미달 시 중단이 계약이다.
- **심판 루브릭 채점 기준 변경** — 출력 필드 추가만. 오탐 재조정은 별도 스텝.
- **miscited 겨냥 프롬프트 규칙** — 이번 표적은 unsupported. miscited는 관측성만 확보한다.
- 온라인(운영 트래픽) groundedness 관측 — spec 30과 동일하게 오프라인 축만.
- FE 표시.
