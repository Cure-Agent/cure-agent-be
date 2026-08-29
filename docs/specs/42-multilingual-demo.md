# 42. 다국어 데모 — 영문 질의·응답과 인용 근거 번역

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 테스트로 동결되며, 구현 중 수정할 수 없다.

## 목표

영어권 방문자가 §5.3 지침 질의를 자기 언어로 던지고, 답변과 **그 답변이 딛고 선 근거를 같은 언어로**
읽게 한다. §7은 인용 DTO를 「원문 대조에 필요한 최소 집합」이라 못 박았는데, **한국어를 못 읽는
사람에게 그 집합은 대조 수단이 아니다** — 근거가 답을 지지하는지 판단할 수 없으면 인용은 장식이고,
이 제품이 파는 것은 그 대조 가능성이다.

새 검색을 만들지 않는다. **검색은 언제나 한국어로 돈다**(§12 하이브리드). 이 스텝이 더하는 것은 셋뿐이다
— ⑴ 입구에서 질의를 한국어로 정규화하고 ⑵ 출구에서 답변을 **질의 언어**로 내고 ⑶ 근거의 영문 번역을
**미리 만들어 둔다**. 런타임 번역은 ⑴ 하나이고, 근거 번역은 배치 산출물이라 요청 경로에 들어가지 않는다.

## 실측 조사 (2026-08-29, `hybrid_probe` 스크래치 DB + 왕복 번역 프로브)

| 확인 항목 | 실측 |
|---|---|
| ACTIVE 코퍼스 | **7,154 청크 / 63 버전 / 8,872,934자** · 평균 1,240자 — §41이 기록한 수와 일치 |
| 6주제 번역 대상 | **655 청크 / 906,443자 = ACTIVE의 9.2%** (편두통 130 · 불면 157 · ADHD 194 · 골다공증 51 · 류마티스 53 · 만성요통 70) |
| 지침 제목·발행처 오염 | ACTIVE 63건 중 **제목 후행 탭 2건**(그중 하나가 6주제의 ADHD) · 발행처 공백/탭 4건 |
| **`trim()`의 함정** | PostgreSQL `trim()`은 **탭을 지우지 않는다** — ADHD 제목이 `length=24 = length(trim)=24`다. `btrim(title, E' \t\n\r')`가 아니면 대상 1건이 조용히 빠진다 |
| 인용의 `quote` 정체 | **LLM이 고른 스니펫이 아니다** — `truncate(chunk.content, 120)`, 즉 청크 원문의 앞 120자다(`conversation-stream.service.ts:448`). 같은 파일 609행이 이미 「quote 발췌가 아니라 청크 원문이다」로 취급한다 |
| 키워드 arm의 정체 | `word_similarity(query, content)` = pg_trgm 문자 n-gram(`retrieval.service.ts:215`) — **영문 질의는 이 arm이 0에 수렴한다** |
| 기권 사유 전달 형태 | BE가 사유별 **한국어 문장**을 직송한다(`conversation-stream.service.ts:98`, 주석: 「FE가 reason을 그대로 표시하므로」). 내부에는 `AbstainReason` 코드가 이미 있다 |
| 프로덕션 기권률 | **56%**(35/63, §41) — 영문 화면에서 가장 자주 노출될 문구가 기권 문구다 |

**왕복 번역 프로브** — 예시 질의문 6개를 KO→EN→KO로 왕복시켜(`gpt-5.4-mini`) 원문과 나란히
`searchHybrid`에 태웠다. 대상은 평가셋의 기대 근거(지침 + 권고번호)이고, 순위는 armK=30 기준이다:

| 문항 | 융합 | 벡터 arm | 키워드 arm | 거리 | Recall@5 |
|---|---|---|---|---|---|
| 요통 원문 / 왕복 | 1 / 1 | 1 / 2 | 1 / 4 | 0.2891 / 0.3763 | O / O |
| 불면 원문 / 왕복 | 6 / 10 | 26 / 29 | 13 / 12 | 0.3079 / 0.3095 | **X / X** |
| 편두통 원문 / 왕복 | 1 / 3 | 1 / 1 | 1 / **없음** | 0.1935 / 0.2335 | O / O |
| 골다공증 원문 / 왕복 | 1 / 1 | 1 / 1 | 7 / 2 | 0.2684 / 0.2276 | O / O |
| ADHD 원문 / 왕복 | 1 / 1 | 6 / 4 | 2 / 8 | 0.3234 / 0.2347 | O / O |
| 류마티스 원문 / 왕복 | 1 / 1 | 1 / 1 | 1 / 2 | 0.3350 / 0.3527 | O / O |

리랭크를 켠 같은 12문항 실행에서 **top-1 관련도가 전부 컷 9 이상**이었다(10점 11건 · 9점 1건).
컷 10으로 올려야 1건이 걸린다. **왕복 번역은 기권을 만들지 않았다.**

세 줄이 이 스펙을 결정한다.

**⑴ Recall@5 실패 집합이 원문과 왕복에서 동일하다** — 불면 1문항뿐이고, 그 문항은 **원문에서도 실패**한다.
§41이 「불면 칸은 원문보다 넓힌 질문이라 스윕 이력이 담보가 아니다」라고 남긴 그 항목이며 담보는
프로덕션 2/2였다. 왕복이 새로 깨뜨린 문항은 **0건**이다.

**⑵ 키워드 arm은 실제로 약해진다.** 편두통은 원문에서 키워드 1위였는데 왕복 후 **top-30 밖으로 사라졌고**,
벡터 arm(1위)이 혼자 끌어 융합 3위로 살아남았다. 요통 1→4, ADHD 2→8도 같은 방향이다. 어휘가 이동하기
때문이다 — 왕복본에서 **유침→「침을 두는 시간」**, 혈자리→경혈, 취혈 원칙→혈위 선정 원칙,
「류마티스 관절염」→「류마티스관절염」(띄어쓰기 소실)이 관측됐다. 문자 n-gram은 이 이동을 그대로 맞는다.

**⑶ 따라서 영문 경로는 §31 하이브리드에 의존한다.** 벡터 arm 단독이었다면 편두통은 살아남았겠지만
불면·ADHD는 더 나빠졌고, 키워드 단독이었다면 편두통이 죽었다. 두 arm의 합집합이 번역 경로를 살렸다 —
이는 곧 **`RETRIEVAL_RERANK_ENABLED=false` 같은 롤백이나 키워드 arm 장애에서 영문 경로가 먼저 무너진다**는
뜻이고, 아래 「위험」에 남긴다.

## 판단 근거 (2026-08-29 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 답변을 번역하는가 | **아니다 — 생성 단계에서 그 언어로 쓴다.** 후처리 번역은 ⑴ 전체 버퍼링이 필요해 §8의 `answer.delta` 스트리밍이 의미를 잃고 ⑵ 프롬프트 규칙 2의 `[n]` 마커를 번역기가 흘리면 **인용이 영속화되지 않으며** ⑶ 저장된 답변과 화면의 답변이 갈라져 §5.7 재현성 계약이 끊긴다. 규칙 5(「한국어로 간결하게 답한다」)를 언어 분기로 바꾸는 것이 전부다 |
| 질의는 번역하는가 | **번역한다 — 검색 입력으로만.** LLM이 영어를 못 읽어서가 아니라 **키워드 arm이 문자 n-gram이라서**다(실측). 번역하지 않으면 두 arm 중 하나가 통째로 죽고, 기권률 56%인 검색이 영문에서 더 나빠진다 |
| 번역을 어느 문으로 부르는가 | **`QueryTranslator` 포트 신설 — §29·§33과 같은 이유다.** `LlmGateway`는 범용 호출기가 아니라 답변 생성 파이프라인 전체다: `{question, evidence}`를 받아 `prompt-builder`가 QA 시스템 프롬프트를 씌우고 델타를 스트리밍하며 판정을 파싱하고 `GenerationRun`·토큰 지표를 남긴다. 번역을 태우려면 `evidence: []`를 넣고 프롬프트 빌더를 우회하고(게이트웨이의 존재 이유) **게이트가 켜진 구성에서 강제되는 `response_format`**(답변 JSON 스키마) 안에 번역문을 숨겨 꺼내야 하며, 지표에는 답변 생성 1건이 찍힌다. `reranker.port.ts`가 이미 같은 판단을 문장으로 남겼다 — 「그 계약은 근거 인용 답변 전용이고, 리랭크는 비스트리밍 단발 호출이다」. 번역도 같은 모양이다. **재시도는 잃지 않는다** — `withRetry`가 게이트웨이에 묶이지 않은 독립 헬퍼(`resilience/retry-policy.ts`)라 포트가 그대로 감싼다. 서킷브레이커·프로바이더 폴백은 붙이지 않는다: 번역에는 폴백할 대상이 없고, 실패는 기준 7대로 시끄럽게 끝나는 것이 옳다 |
| 답변 언어를 무엇이 정하는가 | **요청의 `responseLang`이고, FE는 그 값을 입력 언어에서 유도한다.** UI 언어에서 유도하지 않는다 — §41 기준 27이 「예시를 누르면 입력창 값이 그 문장이 된다」이므로 화면에 보이는 문장과 전송되는 문장이 같아야 하고, 그러면 질의 언어와 답변 언어는 **저절로 일치한다**. BE가 문자열로 추론하지 않는 이유는 짧은 질의·혼합 언어에서 판정이 흔들리기 때문이다 |
| 재조회의 언어 | **`messages.response_lang`에 기록한다.** `GET /conversations/{id}/messages`에는 질의도 `responseLang`도 실리지 않는데 답변은 이미 영어로 저장돼 있다. 기록하지 않으면 **대화 목록에 갔다 돌아오는 순간 인용 번역이 사라진다** — 데모에서 흔한 동선이다. `promptVersion`에 인코딩하는 안은 표시 로직이 버전 문자열을 파싱하게 만들어 기각 |
| 번역본을 임베딩하는가 | **하지 않는다.** 검색 질의를 한국어로 통일했으므로 영문 벡터가 쓰일 자리가 없다. 만들면 §14의 「같은 모델로 만들어진 청크만 검색 대상」에 언어 축이 하나 더 붙고 `policyVersion`이 언어까지 표현해야 하며, **229문항 기준선이 무효화된다.** 번역본이 검색·생성 경로에 들어가지 않는다는 성질이 이 스텝을 싸고 안전하게 만드는 전부다 |
| 번역을 어디에 두는가 | **`evidence_chunk_translations` 테이블 — embedding과 같은 규율.** 소스코드 상수는 안 된다: §25·§26이 개정을 설계된 사실로 두었으므로 원문과 번역이 다른 생명주기를 가지면 개정된 날 번역만 조용히 낡은 문장을 가리킨다. `source_content_hash`를 `evidence_chunks.content_hash`와 대조하면 그 낡음이 **자동으로 드러난다** |
| 컬럼이 아니라 별도 테이블인 이유 | 언어 추가에 스키마 변경이 없고, 검색이 매 요청 읽는 hot row(`content`+`embedding`)를 무겁게 하지 않으며, 인제스트 트랜잭션 밖에서 비동기로 채울 수 있다 |
| 1차 대상 범위 | **6주제 655청크만.** 전량(887만 자)도 1회성으로는 감당 가능하지만, 데모가 밟는 경로는 6주제가 100%이고 잡이 멱등이라 **확장에 코드 변경이 없다**(대상 필터만 넓힌다). 그 밖의 근거는 한국어 원문만 보이며, 그 경계를 화면이 밝힌다 |
| 커버리지 밖 표시 | **인용 카드에 배지.** 답변 상단 1회 안내는 어느 근거가 해당하는지를 알려주지 못한다. 배지는 경계를 **근거 단위로** 드러내 고장이 아니라 범위로 읽히게 한다 |
| `quote`를 번역하는가 | **한다 — 배치 산출물로 충분하다.** quote가 LLM이 고른 스니펫이면 청크 번역에서 대응 조각을 잘라낼 수 없지만, 실측대로 **앞 120자 기계 절단**이라 청크 번역을 같은 방식으로 자르면 된다. 런타임 번역 호출이 0으로 유지되므로 「짧으니 실시간으로 돌린다」는 안은 이득 없이 실패 모드만 늘린다 |
| 영문 절단 길이 | **`QUOTE_LIMIT_EN = 240`.** 한국어 120자를 영어로 옮기면 대략 두 배가 되므로 120을 그대로 쓰면 같은 정보량이 안 나온다 |
| 기권 문구의 소유 | **BE가 언어별 문구표를 든다.** `ABSTAIN_REASON_MESSAGE`를 언어별로 확장해 `responseLang`에 맞는 문장을 고른다. `reasonCode`를 노출해 FE가 문구를 드는 안(카피 소유를 FE로 옮겨 BE 배포 없이 언어를 더하는 길)은 **이번에 택하지 않는다** — 지원 언어가 둘이고 문구가 3개뿐이라 BE에 두는 비용이 작고, 계약 변경이 0이다. 언어가 셋째로 늘거나 문구 톤을 자주 고치게 되면 그때 `reasonCode`로 옮긴다 |
| `missingInformation` | **손대지 않는다.** LLM이 생성한 구절이라(§40 `missingAspects`) 문구표로 옮길 수 없고, 생성이 영어로 돌면 **저절로 영어로 나온다** |
| 용어집 | **넣는다 — 생성 프롬프트와 번역 잡이 같은 목록을 읽는다.** 실측이 근거다: 왕복본에서 유침·취혈이 다른 말로 바뀌었다. 답변이 `pharmacopuncture`라 쓰고 인용 번역이 `medicinal acupuncture`라 쓰면 독자는 **근거가 답을 지지하지 않는다고 읽는다** — 검증 UI에서는 오역보다 치명적이다. 목록은 사람이 관리하는 수십 항목이라 소스에 둔다(코퍼스와 달리 유한하고 저자가 우리다) |
| 예시 질의문의 영문판 | **왕복 프로브를 통과한 문장을 고정한다.** §41이 「다듬은 문장」을 미실측으로 넘겼다가 프로덕션에서 기권한 전례가 있으므로, 이번 6문장은 **스펙 작성 단계에서 검색을 태워** 위 표를 얻은 뒤 고정한다 |

**위험.** ⑴ 영문 경로는 두 arm의 융합에 의존한다(실측 ⑵⑶) — 리랭크·키워드 arm을 끄는 롤백에서 한국어보다
먼저 무너지므로, 기권 메트릭에 `lang` 라벨을 붙여 두 경로를 **따로 센다.** ⑵ 왕복 번역의 검색 영향은
`gpt-5.4-mini` 1회 실행으로 쟀다 — 번역 모델을 바꾸면 위 표의 담보가 끊긴다. ⑶ 불면 칸은 원문에서도
Recall@5 실패이며 담보는 프로덕션 관측뿐이다(§41에서 물려받은 미해소 항목).

## 범위 (엔드포인트)

**신규·삭제 엔드포인트 없음.** 계약 변경은 전부 additive다 — `POST /conversations/{id}/messages/stream`
요청에 `responseLang?`, `EvidenceDetailResponseDto`에 `excerptTranslated?`·`translationModel?`,
`AnswerCitationResponseDto`에 `quoteTranslated?`·`titleTranslated?`. `pnpm openapi:export` diff가
이 다섯 필드의 추가뿐이어야 한다(§1 contract 테스트가 지킨다).

| 진입점 (BE) | 변경 |
|---|---|
| `query-language.ts` (신규) | 한글 코드포인트 비율로 입력 언어 판정 — **검색 번역 여부에만** 쓴다. 표시와 무관해 오판이 화면을 깨지 않는다 |
| `query-translator.port.ts` 외 3 (신규) | EN→KO **단발 번역 포트** — 포트·openai 구현·fake·factory 4파일. 리랭커(§29) 구조를 그대로 따른다. 재시도는 `withRetry`를 그대로 쓰고, 결과는 Redis 캐시 |
| `prompt-builder.ts` | 규칙 5를 언어 분기로. `PROMPT_VERSION`이 영문 경로에서 갈린다(`qa-v6` / `qa-v6-en`) |
| `terminology.ts` (신규) | 용어집 — 생성 프롬프트와 번역 잡이 함께 읽는다 |
| `conversation-stream.service.ts` | `ABSTAIN_REASON_MESSAGE`를 언어별로. `QUOTE_LIMIT_EN=240` |
| `evidence-chunk-translation.schema.ts` (신규) | 아래 마이그레이션 |
| `chunk-translator.service.ts` (신규) | **멱등 잡** — 번역이 없거나 stale한 ACTIVE 청크를 채운다. 대상 필터는 `btrim(title, E' \t\n\r')` 정규화 부분일치(실측: `trim()`은 탭을 못 지운다) |
| `scripts/translate-chunks.ts` (신규) | `pnpm translate:chunks [--all]` — 기본은 6주제, `--all`이 전량 |
| `guideline.mapper.ts` · `conversation.mapper.ts` | 번역 additive. **stale이면 키를 싣지 않는다** |
| `docs/architecture.md` | §5.3에 언어 축 한 줄, §8에 `responseLang` |

| 진입점 (FE — `cure-agent-fe`) | 변경 |
|---|---|
| `shared/i18n/` (신규) | 고정 문구 ko/en 리소스. 언어 판정은 `navigator.language` → `ko-*`면 ko, 그 외 en. 선택은 localStorage가 이긴다 |
| `ask-guideline/lib/suggested-prompts.ts` | 예시 질의문에 영문판 병기. **표시된 문장이 그대로 전송된다** |
| `ask-guideline/lib/response-lang.ts` (신규) | 입력 언어 → `responseLang` |
| `ask-guideline/ui/citation-card.tsx` | 번역 표시 + 「Show Korean original」 토글 + 미번역 배지 |

## Entity / 마이그레이션 변경분

- **신규 `evidence_chunk_translations`** — `chunk_id`(FK) · `lang` · `content` · `source_content_hash` ·
  `translator_model` · `translated_at`, `unique(chunk_id, lang)`. **임베딩 컬럼을 두지 않는다**(판단표).
  `source_content_hash`는 §18 「벡터는 evidence_chunks에만」과 같은 규율의 번역판이다 — 파생물은
  자신이 무엇에서 파생됐는지를 들고 있어야 낡음을 스스로 드러낸다.
- **`messages.response_lang`** — 재조회가 요청 없이 언어를 알기 위한 유일한 축. 기본 `'ko'`로
  백필해 기존 행의 동작을 보존한다.

## 추가 에러코드

없음 — 질의 번역 실패는 §11 LLM 인프라의 기존 코드(`LLM_UNAVAILABLE`·`LLM_TIMEOUT`)로 흡수되고,
번역이 없는 청크는 오류가 아니라 **필드 부재**다.

## 수용 기준 (= 동결할 시나리오, Definition of Done)

**한국어 경로는 한 바이트도 바뀌지 않는다** — 229문항 기준선과 groundedness 실측이 유효하게 남는 조건

1. 한국어 질의는 번역기를 **호출하지 않는다** (BE 유닛)
2. 한국어 질의에서 검색에 넘어간 문자열이 원문과 **동일하다** (BE 유닛)
3. `responseLang`이 없는 요청은 `ko`로 처리된다 (BE e2e — 기존 클라이언트 형태 유지)
4. 한국어 경로의 `promptVersion`이 `qa-v6` 그대로다 (BE 유닛)

**질의 번역은 검색에만 쓰인다**

5. `responseLang=en`이면 검색에 넘어간 문자열이 번역기의 산출물이다 (BE e2e — fake 번역기)
6. 같은 요청의 `GenerationRun`에 **원문 질의와 번역 질의가 모두** 남는다 (BE e2e — §5.7 재현성)
7. 번역기가 실패하면 스트림이 `LLM_UNAVAILABLE`로 끝난다 (BE e2e — 원문으로 조용히 검색하지 않는다)

**답변 언어는 요청이 정하고, 기록된다**

8. `responseLang=en`이면 생성 프롬프트의 언어 규칙이 영어다 (BE 유닛)
9. 영문 경로의 `promptVersion`이 `qa-v6-en`이다 (BE 유닛)
10. `messages.response_lang`에 그 답변의 생성 언어가 저장된다 (BE e2e)
11. 메시지 재조회가 **요청에 언어가 없어도** 저장된 언어의 번역을 싣는다 (BE e2e)

**인용 번역은 배치 산출물이고, 낡으면 사라진다**

12. 번역이 있는 청크의 인용에 `quoteTranslated`·`excerptTranslated`가 실린다 (BE e2e)
13. `quoteTranslated`가 청크 번역을 **240자로 자른 것**이다 (BE 유닛)
14. 번역이 없는 청크는 그 **키 자체가 응답에서 빠진다** (BE e2e — 빈 문자열을 싣지 않는다)
15. `source_content_hash`가 청크의 `content_hash`와 다르면 번역을 **싣지 않는다** (BE e2e — stale)
16. 한국어 응답에는 번역 키가 실리지 않는다 (BE e2e)
17. `quote`(한국어)는 번역 유무와 무관하게 **항상 실린다** (BE e2e — §7 「최소 집합」 유지)

**번역 잡은 멱등하고, 오염된 제목을 놓치지 않는다**

18. 잡을 두 번 돌려도 `evidence_chunk_translations` 행이 늘지 않는다 (BE e2e)
19. 기본 실행의 대상이 6주제 지침의 ACTIVE 청크뿐이다 (BE e2e)
20. **후행 탭이 붙은 제목의 지침이 대상에 포함된다** (BE e2e — ADHD. 대상 필터가 SQL `btrim`이라 실 DB로만 단언된다. `trim()`으로는 빠진다)
21. 원문 청크의 `content_hash`가 바뀌면 그 번역이 stale로 판정된다 (BE 유닛)
22. `translator_model`이 행마다 기록된다 (BE e2e — provenance)

**번역본은 검색·생성 경로에 들어가지 않는다**

23. 번역 유무가 `searchHybrid` 결과를 바꾸지 않는다 (BE e2e — 같은 질의, 번역 적재 전후 동일)
24. `evidence_chunk_translations`에 임베딩 컬럼이 없다 (BE — 스키마 단언)
25. `pnpm openapi:export` 재생성본이 커밋된 스펙과 같다 (BE — 기존 contract 테스트, 회귀)

**기권 문구는 답변 언어를 따른다**

26. 세 사유(`no_candidates`·`beyond_cutoff`·`insufficient_evidence`)가 `responseLang=en`에서 **각각 다른 영문 문장**을 낸다 (BE 유닛 — §28 기준 5의 「사유가 다르면 다르게 읽혀야 한다」를 영어에서도 지킨다)
27. `responseLang=ko`의 세 문구가 오늘과 **자구까지 같다** (BE 유닛 — 회귀)

**화면은 언어를 유도하고, 경계를 밝힌다**

28. `navigator.language`가 `ko-*`면 한국어, 그 외면 영어로 시작한다 (FE 유닛)
29. localStorage에 저장된 선택이 자동 판정을 **이긴다** (FE 유닛)
30. 예시 질의문이 UI 언어로 표시된다 (FE 유닛)
31. 예시를 누르면 **표시된 그 문장이** 입력창에 채워진다 (FE 유닛 — §41 기준 27 계승. 영문을 눌러 한국어가 채워지지 않는다)
32. `responseLang`을 **입력 언어**에서 유도해 보낸다 — 한국어 UI에서 영문 질의를 보내면 `en`이다 (FE 유닛)
33. 번역이 없는 인용 카드에 미번역 배지가 뜬다 (FE 유닛)
34. 번역이 있는 카드에는 배지가 뜨지 않는다 (FE 유닛)
35. 어느 카드에서도 **한국어 원문에 도달할 수 있다** (FE 유닛 — 정본은 원문이다)

**예시 질의문의 영문판을 잠근다**

36. FE의 영문 예시 6개가 아래 문자열과 **자구까지 같다** (FE 유닛 — §41 기준 30과 같은 이유. 문구가 바뀌면 위 왕복 프로브의 담보가 끊긴다)

| 주제 | 영문 |
|---|---|
| 만성요통 | For adult patients with chronic nonspecific low back pain, when providing acupuncture treatment, is a standardized prescription using the same acupoints for all patients or an individualized prescription tailored to each patient recommended? |
| 불면 | What herbal medicine prescription can be considered to improve insomnia symptoms in adult patients with primary insomnia? |
| 편두통 | In patients with migraine, when considering electroacupuncture treatment, can it help improve symptoms or relieve headache intensity compared with conventional medication treatment? |
| 골다공증 | When considering acupuncture for a patient with osteoporosis to improve bone density or relieve pain, what is the usual appropriate retention time for the needles? |
| ADHD | In what clinical situations can herbal medicine treatment be considered first for children and adolescents with ADHD? |
| 류마티스 | When using pharmacopuncture to relieve symptoms in adult patients with rheumatoid arthritis, what acupoint selection principles should be applied in addition to the treatment site, and what safety precautions are necessary before using bee venom pharmacopuncture? |

fixture 규약: e2e는 **실 LLM·실 번역기·실 코퍼스를 부르지 않는다.** 번역기는 결정적 fake로 치환하고,
청크 번역은 지침 원문이 아니라 **구조를 모방한 합성 텍스트**로 적재한다(§13). 기준 13·15·20의 기대값
원천은 이 문서의 실측표이며, 구현의 상수를 읽어 기대값을 만들지 않는다 — 그러면 오라클이 구현을 따라가
무엇도 검증하지 못한다(§41 fixture 규약과 같은 이유).

## Out of scope

- **전량 번역** — 1차는 6주제 655청크다. 잡의 대상 필터만 넓히면 나머지 6,499청크(약 797만 자)로
  확장되며 **코드 변경이 없다.** 확장 시점은 6주제 번역 품질을 눈으로 확인한 뒤다
- **`reasonCode` 노출** — 기권 문구를 BE가 계속 소유한다(판단표). 언어가 셋째로 늘거나 문구 톤을
  자주 고치게 되면 그때 FE로 옮긴다
- **다국어 검색** — 영문 임베딩·다국어 리트리버는 만들지 않는다. 검색은 한국어 단일 축이다
- **인용이 근거의 앞 120자만 보여주는 문제** — `QUOTE_LIMIT`의 기존 동작이며 언어와 무관한 축이다.
  영문 카드도 같은 절단 규칙을 따른다
- **한국어 외 제3언어** — `ko`·`en` 둘뿐이다. `evidence_chunk_translations.lang`이 확장을 막지 않는
  형태일 뿐, 셋째 언어의 문구·번역·판정은 이 스텝이 다루지 않는다
- **번역 품질의 자동 관측** — 용어집 준수 여부를 재는 지표를 만들지 않는다. 6주제 655청크는 사람이
  훑을 수 있는 분량이고, 전량 확장 시점에 다시 판단한다
