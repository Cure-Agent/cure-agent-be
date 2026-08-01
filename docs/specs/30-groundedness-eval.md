# 30. groundedness 평가 — 생성 축의 miscite·무근거 주장 측정

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.**

## 목표

§27이 «검색 품질이 상한이므로 검색부터»라며 미뤄둔 생성 축을 실행한다. 검색이 상한에
도달한 지금(리랭크 Recall@5 0.983) 남은 오답 경로는 생성이다 — **근거를 제대로 찾아줘도
답변이 근거를 배반하면** 검색 개선은 무의미해진다. 답변을 주장 단위로 채점해 miscite율과
무근거 임상 주장률을 재고, 이후 프롬프트·모델 변경의 전후 비교 축을 만든다.

## 실측 조사 (2026-08-02, 프로덕션 코퍼스 × answerable 59문항 파일럿)

실경로 재현(검색 K=30 → 실 리랭크 → top-5 → qa-v3 → gpt-5.4-mini 생성) 후 LLM 심판 채점.

| 확인 항목 | 실측 |
|---|---|
| verdict 분포 | **grounded 48/59 (81.4%) · partial 11 · ungrounded 0** |
| 주장 단위 (총 266) | supported 94.7% · **miscited 5건(1.9%)** · unsupported 9건(3.4%) |
| **unsupported 9건의 절반 이상이 심판 오탐** | 「최종 적용은 의료인이 판단」(면책)·「제공된 근거로는 부족」(한계 고지)을 무근거 주장으로 채점 — **qa-v3 규칙 3·4가 요구하는 문구**다. 루브릭에 예외를 적었는데도 걸렸으므로 명시적 예시 나열이 필요하다 |
| 실질 결함률 | 오탐 제외 시 주장 단위 **~3.5%** — miscite 5(인용이 달려 검증된 것처럼 보이는 유형, 안전 최우선) + 근거 범위를 넘는 처방 나열류 4~5 |
| qa-v3 기계 검사 | 마크다운 위반 0/59 · 마커 미사용 0/59 — 정규식으로 판정 가능한 규칙은 완벽 준수 |
| 파이프라인 부수 검증 | 리랭크 폴백 0/59 (#194 실경로 검증) · 생성 지연 p50 1.3s · 심판 파싱 실패 0/59 |
| 비용 | 문항당 생성+채점 ≈ $0.005 — 59문항 1회 ~$0.3 |

### 지표는 뭉뚱그리지 않는다 — miscite와 무근거를 분리한다

파일럿의 교훈: 단일 「groundedness 점수」는 성격이 다른 결함을 섞는다. **miscite**(마커가
가리키는 근거가 문장을 지지하지 않음)는 사용자가 검증됐다고 믿게 만드는 인용 사기라 안전
최우선이고, **무근거 임상 주장**은 할루시네이션 축이며, 면책·한계 고지는 결함이 아니라
**규칙 준수**다. 리포트는 세 축을 분리해 싣는다.

### 심판은 gpt-5.4-mini + 루브릭 v2다 (2026-08-02 사용자 확정)

생성 모델과 같은 모델이 채점하는 자기 채점 편향 리스크를 명시한다 — 다만 파일럿에서 자기
출력에 partial 18.6%를 준 것이 과잉 관대함의 반증이다. 루브릭 v2는 파일럿 오탐 사례를
**명시적 예시로 나열**해 비주장 처리한다: 면책(「의료인이 판단」), 한계 고지(「근거로는
부족」), 재질의 유도. 상위 모델·이중 채점은 결함률 ~3.5% 수준에서 과투자라 보류한다.

### 심판·생성기는 포트 뒤에 있다 — e2e 동결의 성립 조건

생성은 기존 `LlmGateway`(§11 포트)를 재사용하고, 심판은 리랭커 선례(§29)대로 전용 포트
(`GROUNDEDNESS_JUDGE`)를 신설한다 — 외부 유료 API라 **fake 치환 없이는 수용 기준을 동결할
수 없다**(§3 기준). fake 심판은 결정적이다(예: 마커 있는 문장 supported, 없는 문장
unsupported로 기계 판정).

### 검색 평가와 분리된 별도 스크립트다

`eval-rag`는 fake 임베딩으로도 돌지만 groundedness는 실 LLM 없이는 무의미하고, 문항당
비용·지연이 검색 평가의 ~10배다. `pnpm eval:groundedness [평가셋.json]`으로 분리하고,
리포트는 `docs/rag-eval/` 관행(날짜-대상 명명, repo 커밋)을 따른다. **answerable만
생성·채점한다** — abstain 문항은 기권이 정답이라 채점할 답변이 없다.

## 범위 (진입점)

**신규·변경 엔드포인트 없음. 런타임 대화 경로 무변경** — 평가 전용 계층이다.

| 진입점 | 변경 |
|---|---|
| `domain/evaluation/groundedness-judge.port.ts` (신규) | `GROUNDEDNESS_JUDGE` 토큰 + `judge(question, evidence, answer) → {claims, supported, miscited, unsupported, unsupportedExamples, insufficiencyDisclosed, verdict}` |
| `domain/evaluation/openai-groundedness-judge.ts` (신규) | 루브릭 v2(면책·한계 고지 명시 예외), `response_format: json_object`, 파일럿 구성 그대로 |
| `domain/evaluation/fake-groundedness-judge.ts` (신규) | 결정적 fake — e2e·로컬 기본 (키 없으면 등록, embedding 팩토리 선례) |
| `domain/evaluation/groundedness-eval.service.ts` (신규) | answerable 문항 → 실경로 재현 생성(검색 K=30·리랭크·top-5·`LlmGateway`) → 기계 검사(마크다운·마커) → 심판 채점 → 집계 |
| `domain/evaluation/groundedness.report.ts` (신규) | 마크다운 — verdict 분포·주장 단위 3축(supported/miscited/unsupported)·기계 검사·실패 문항 나열 |
| `scripts/eval-groundedness.ts` (신규) + `package.json` | `ingest-guidelines.ts` 패턴의 얇은 래퍼. 생성·채점 오류 문항은 **리포트에 나열하고 비영 종료**(§27 라벨 부패와 같은 이유 — 조용한 스킵은 낙관 오염) |
| `evaluation.module.ts` | 심판 포트 등록·export |

- 심판 모델은 `OPENAI_MODEL`을 재사용한다 — 전용 env를 늘리지 않는다(필요해지면 그때).
- 루브릭의 비주장 예외가 실제로 프롬프트에 실렸는지는 **유닛으로 동결한다**
  (`prompt-rules.spec` 선례 — LLM 응답이 아니라 프롬프트 텍스트를 단언).

## Entity / 마이그레이션 변경분

없음.

## 추가 에러코드

없음 — 평가 스크립트 계층이다.

## 수용 기준 (= 동결할 e2e 시나리오, Definition of Done)

1. 평가는 answerable 문항만 생성·채점한다 — abstain 문항은 결과에 나타나지 않는다.
2. 생성은 리랭크 경로를 탄다 — 순서 뒤집기 fake 리랭커를 주입하면 심판에 전달되는 근거가
   뒤집힌 상위 5개다 (fake 심판의 호출 기록으로 단언).
3. 심판 집계가 결정적이다 — fake 심판(고정 판정)으로 두 번 실행하면 miscite율·무근거율·
   verdict 분포가 동일하다.
4. 리포트에 verdict 분포(grounded/partial/ungrounded)와 주장 단위 3축(supported·miscited·
   unsupported)이 각각 라벨과 값으로 실린다.
5. 리포트에 기계 검사 결과(마크다운 위반 수·마커 미사용 답변 수)가 실린다.
6. 생성 또는 채점이 실패한 문항은 리포트에 나열되고 프로세스는 **비영 종료**한다.
7. 실물 심판의 루브릭에 면책·한계 고지 비주장 예외가 명시돼 있다 (유닛 — 프롬프트 텍스트 단언).
8. `OPENAI_API_KEY`가 없으면 fake 심판이 등록된다 (팩토리 — 유닛 또는 e2e).

## Out of scope

- **온라인 샘플링 채점**(운영 트래픽 실시간 groundedness) — 오프라인 축이 자리잡은 뒤.
- 상위 모델 심판·이중 채점 — 결함률 ~3.5%에서 과투자. 결함률이 튀면 재검토.
- 답변 완결성·문체 등 groundedness 외 품질 축.
- abstain 답변(기권 문구)의 채점.
- 프롬프트(qa-v3) 개선 자체 — 이 스텝은 측정이고, 개선은 이 지표의 전후 비교로 다음에.
- FE 표시.
