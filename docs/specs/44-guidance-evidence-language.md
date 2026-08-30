# 44. 참고안·근거의 언어 — 질의한 언어로 응답 내용이 표시된다

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> 완료된 spec은 커밋 로그처럼 기록으로 남을 뿐이므로, 이 디렉토리를 읽어 시스템을 이해하려 하지 말 것.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 e2e 테스트로 동결되며, 구현 중 수정할 수 없다.
> 스펙 결함 발견 시: spec을 먼저 고치고 테스트를 재동결한다 (사유를 커밋 메시지에).

## 목표

이 스텝은 둘을 한다.

**⑴ 표시 언어의 축을 바꾼다** — 채팅 화면의 내용물은 UI 토글이 아니라 **사용자가 물은 언어**를
따른다. §42가 `responseLang`을 입력 언어에서 유도해 놓고 FE는 표시를 토글로 갈랐기 때문에,
지금 **한국어 토글로 영문 질의를 하면 영어 답변 옆에 한국어 인용이 선다**(관측). 축이 하나여야
답과 근거를 나란히 읽을 수 있다. 화면이 실제로 읽는 값은 그 질의로 만들어진
**`messages.response_lang`**이다 — 왜 질의를 다시 판정하지 않는지는 판단표에 있다.

**⑵ 그 축 위에서 한국어가 남는 자리를 없앤다** — 환자 맞춤 참고안(§5.6)과 근거 전문은 §42의
경로 밖에 있었다. §42가 「근거가 답을 지지하는지 판단할 수 없으면 인용은 장식」이라 쓴 문장은
**검토 항목에서 더 강하다**: 답변은 본문이 영어라 요지가 전달되지만, 참고안은 화면 전체가
그 판단물이라 한국어면 「검토」 자체가 성립하지 않는다.

## 관측 (2026-08-31, 프로덕션 DB + 코드 대조)

**영문 참고안 3건은 전부 구조화 경로다** — `deterministic-v1` 폴백 0건.

| `response_lang` | `composer_version` | n | 기간 |
|---|---|---|---|
| en | `guidance-v2` | **3** | 08-30 |
| ko | `guidance-v2` | 15 | 08-03~08-29 |
| ko | `deterministic-v1` | 4 | 08-01~08-03 (§33 이전 행) |

그 3건에 실제로 저장된 값:

| 필드 | 값 | 원인 |
|---|---|---|
| `summary` | `For adult patients with rheumatoid arthritis, pharmacopunctu…` | **영어** — 답변 앞 200자라 저절로 |
| `considerations[].title` | `류마티스 관절염의 약침 치료 고려` | `guidance-prompt.ts:38` 규칙 7 「한국어 평문으로 쓴다」 |
| `considerations[].rationale` | `류마티스 관절염 환자의 증상 개선을 위하여…` | 같은 규칙 |
| `safetyAlerts[].description` | `환자에게 꽃가루 알레르기 병력이 있습니다…` | `composer:113` 하드코딩 |
| `patientFactors`·`missingInformation` | `["진단명"]` · `허리둘레, 임상 메모` | **FE가 이미 번역한다** (`guidance-card.tsx:70-78`, i18n 키 존재) |
| jsonb 인용의 `quoteTranslated`·`titleTranslated` | **6/6 존재**, 값도 영어 | 타입에 없는 채 런타임에 저장돼 왔다 — 계약에 선언만 없다 |

**`GET /evidence/{id}`는 구조적으로 영원히 한국어다.** §42가 매퍼(`toEvidenceDetail`)를 번역 대응으로
만들었지만 인자가 닿는 호출자가 하나뿐이다:

| 지점 | 상태 |
|---|---|
| `conversation-stream.service.ts:353` (`retrieval.completed`) | 번역·언어를 넘긴다 ✅ — **§42 기준 12b가 검증한 쪽** |
| `guideline.service.ts:101` (`GET /evidence/{id}`) | `toEvidenceDetail(row)` — 언어 인자 없음 → 기본 `'ko'` → `usableTranslation` ①에서 즉시 null |
| `guideline.repository.ts:340` `findEvidenceDetail` | `evidence_chunk_translations` **조인 자체가 없다** |
| `evidence.controller.ts:15` | 언어를 받을 파라미터가 없다 |

FE는 준비돼 있다 — `evidence-full-text.tsx:35,62`가 `excerptTranslated`를 읽고 미번역 배지와
「Show Korean original」 토글까지 구현돼 있으며, **세 화면이 이 컴포넌트 하나를 공유한다**
(`guidance-card.tsx:93` 검토 항목 · `evidence-inspector.tsx:190` 인용 근거 탭 ·
`guideline-detail-panel.tsx:128` 지침 탐색기).

**섹션 경로는 번역 원천이 없다.** 펼침 헤더가 `guidelineTitle · v… · sectionPath`인데
(`guidance-card.tsx:116` · `evidence-inspector.tsx:149`), 앞 둘만 영어가 되면 **한 줄 안에서
언어가 갈린다**: `Osteoporosis Korean Medicine CPG · v1.0 · Ⅳ. 권고사항 > 1. 침`.
영문 3건이 실제 인용한 경로는 `Ⅳ. 권고사항 > 1. 침` · `Ⅳ. 권고사항 > 1. 한의 단독치료 > 3) 약침 치료` ·
`■ 소아 ·청소년 환자 치료`다.

**규모** — 6주제 = 6버전 / **67섹션** / 655청크 번역(전부 `title_translated` 보유). ACTIVE 63버전.
섹션은 청크의 1/10이라 번역 비용이 작다. ADHD 지침 제목의 후행 탭(§42 실측)이 jsonb 인용에
그대로 굳어 있다.

**표시 언어가 응답 언어와 이미 어긋나 있다.** §42는 BE에서 `responseLang`을 **입력 언어**로 유도
했는데(기준 32), FE는 표시를 **UI 토글**로 가른다(`evidence-inspector.tsx:57` ·
`evidence-full-text.tsx:25` — 「표시 언어는 화면이 아니라 사람의 설정」). 두 축이 만나는 자리에서
갈린다:

```
UI 토글 = 한국어, 사용자가 영어로 질의
  → FE가 responseLang=en 전송 (입력 언어 유도, §42 기준 32)
  → BE가 영어 답변 + quoteTranslated 를 내려보낸다
  → FE가 lang = useUiLang() = 'ko' 로 판정해 번역을 버린다
  → 영어 답변 옆에 한국어 인용이 선다
```

**이 스텝이 근거 전문만 고치고 `?lang=`을 UI 토글로 채우면 같은 불일치가 그대로 재발한다.**

## 판단 근거 (2026-08-31 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| **채팅 화면의 표시 언어를 무엇이 정하는가** | **그 메시지의 `responseLang`이다 — UI 토글이 아니다.** ⑴ 이 제품이 파는 것은 **대조 가능성**인데(§42), 답변과 근거의 언어가 다르면 그 대조가 깨진다 — 근거의 언어는 그것이 딛고 선 답변을 따라야 한다 ⑵ 한 대화에 여러 언어가 섞일 수 있고, `responseLang`은 **메시지 단위**라 각 블록이 자기 언어로 선다. UI 토글은 대화 전체를 한 언어로 강제해 이 사실을 표현하지 못한다 ⑶ 관측대로 지금 이미 어긋나 있다. **§42의 FE 판단(「표시 언어는 사람의 설정」)을 이 스텝이 뒤집는다** — 근거가 어느 맥락에 있느냐가 언어를 정하는 것이 옳다 |
| 왜 **질의 언어**를 직접 읽지 않는가 | **의도의 원천은 질의 언어가 맞지만, 화면이 딛을 값은 응답 언어다.** 인과는 `질의 언어 →(FE 유도)→ responseLang → 답변 생성 언어 = messages.response_lang → 표시`이고, 현 설계에서 앞뒤가 항상 일치한다(§42: 「질의 언어와 답변 언어는 저절로 일치한다」). 그럼에도 화면이 **뒤쪽**을 읽어야 하는 이유가 셋이다: ⑴ 화면에 서 있는 것은 답변이고 근거는 그 답변을 지지하는지 보는 대상이라, **대조의 기준이 답변**이다 ⑵ **FE 판정이 틀려도 화면이 스스로 일관된다** — 한국어 질의를 `en`으로 오판하면 답변은 영어로 나오는데, 질의 언어를 기준 삼으면 영어 답변에 한국어 인용이 붙는다. FE 판정은 §42가 「짧은 질의·혼합 언어에서 흔들린다」고 인정한 축이다 ⑶ 재조회에서 질의를 **다시 문자열로 판정하는 것은 §42가 이미 기각**했고, `response_lang`은 「그때 실제로 무슨 언어로 답했는가」의 기록이라 추론이 필요 없다. 훗날 「질의는 한국어, 답변은 영어」 같은 설정이 생겨 둘이 갈리면, 그때도 화면은 답변 편에 선다 |
| 어디까지가 「내용물」인가 | **번역된 콘텐츠와 같은 카드 안에서 그 콘텐츠를 설명하는 문구까지.** 답변·인용·근거 전문·참고안 본문·기권 문구에 더해, 근거에 밀착한 「미번역」 배지가 포함된다. 그 카드 **밖**의 앱 크롬(「인용 근거」 탭 이름·검토 폼·네비게이션)과 입력창·예시 질의문은 UI 토글을 따른다(§42 기준 30·31 유지) — 한국어 UI 사용자가 영문 질의 한 번에 버튼까지 영어가 되는 것은 과하다 |
| 한국어 원문에 어떻게 도달하는가 | **원문 링크로 도달한다 — 「한국어 원문 보기」 토글을 없앤다.** §42는 「정본은 원문이므로 번역을 앞에 두되 원문을 지우지 않는다」며 인라인 토글을 뒀고 기준 35가 그것을 동결했다. 그런데 **모든 인용·근거가 이미 `sourceUrl`(NCKM 원문)을 싣고**, 근거 상세는 `pageStart`·`pageEnd`까지 든다 — 정본 도달 경로가 이미 계약 안에 있다. 영문 독자에게 한국어 문단을 인라인으로 펼치는 버튼은 쓰임이 적은 반면 카드마다 상태와 문구를 하나씩 늘린다. **기준 35의 요구(정본 도달 가능)는 유지하고 충족 수단만 링크로 옮긴다.** `quote`·`excerpt`(한국어)는 응답에 계속 실린다 — §42 기준 17의 「원문 대조 최소 집합」은 계약이지 화면 요구가 아니므로 **계약 변경은 0**이다 |
| `GET /evidence/{id}`의 언어를 무엇이 정하는가 | **쿼리 `?lang=` — 값을 채우는 규칙은 화면이 정한다.** 근거는 대화에 매이지 않은 코퍼스 리소스라 「저장된 언어」가 없다(지침 탐색기에서 열면 대화가 아예 없다). 그래서 요청이 말해야 하고, **채팅 안에서는 그 메시지의 `responseLang`을, 지침 탐색기에서는 UI 토글을** 싣는다. 파라미터가 하나라 BE 계약은 두 경우에 같다 |
| `GET /clinical-guidance/{id}`의 언어를 무엇이 정하는가 | **`messages.response_lang` 조인 — 새 컬럼을 두지 않는다.** 참고안은 `message_id` FK로 메시지에 1:1로 매이므로 §42가 만든 축이 이미 닿는다. §43이 기권 사유에 대해 딛고 선 것과 같은 자리다 |
| 두 엔드포인트가 다른 축을 쓰는 이유 | **참고안은 한 대화의 산물이고 근거는 코퍼스다.** 전자는 저장된 언어가 있고 후자는 없다 — 축이 갈리는 것이 결함이 아니라 리소스 성격의 차이다 |
| 재조회가 메시지 언어를 어떻게 아는가 | **`MessageResponseDto.responseLang`을 노출한다.** 지금은 실리지 않아 대화 목록에 갔다 돌아오면 FE가 그 메시지의 언어를 알 방법이 없다 — §43이 `abstainReason`을 실을 때 언어는 함께 싣지 않았다. 컬럼(`messages.response_lang`)이 이미 있으므로 매퍼가 값을 한 칸 더 옮기면 된다. **이것 없이는 위 판단이 스트림 직후에만 성립하고 재조회에서 무너진다** |
| 검토 항목 본문을 번역하는가 | **아니다 — 생성 단계에서 그 언어로 쓴다.** §42가 답변에 내린 판단과 같은 모양이고, 참고안에는 이유가 셋 더 있다: ⑴ 구조화는 이미 20s 상한(`GUIDANCE_STRUCTURE_TIMEOUT_MS`)에 걸려 폴백률을 재는 중이라 번역 왕복이 상한 초과를 늘리는데, **영문에서 폴백은 곧 한국어 결정적 조립**이다 — 번역을 붙일수록 한국어로 떨어질 확률이 커지는 역설 ⑵ 번역기가 `applicability`·`markers`·`patientFactors`를 흘리면 검증기가 그 항목을 **통째로 폐기**한다(§42가 `[n]` 마커에 한 걱정과 같다) ⑶ 용어집이 답변 생성에 물려 있어 참고안만 다른 어휘를 쓰면 **같은 카드 안에서** 갈린다 |
| 구조화 입력은 번역하는가 | **하지 않는다.** 청크 원문·프로필 라벨을 한국어로 두고 LLM이 영어로 쓰게 한다 — 정본을 읽히는 쪽이 정확하고, 입력 번역은 왕복 손실만 더한다 |
| 생성 시점 언어와 렌더 시점 언어가 한 DTO에 공존한다 | **그렇다 — 렌더 언어를 저장된 `response_lang`으로 고정해 둘을 항상 일치시킨다.** `title`·`rationale`은 생성 시점에 굳고 `safetyAlerts`·폴백 `title`은 렌더 시점에 정해지는데, 후자를 UI 언어로 잡으면 **한 카드 안에서 언어가 갈린다**(한국어로 전환 시 안내 문구만 한국어, 본문은 영어). 이 계약을 명시하지 않으면 「왜 절반만 바뀌냐」가 버그로 올라온다 |
| 권고등급·근거수준 라벨 | **FE가 번역한다 — 필드 라벨과 같은 규율.** 인용 근거 탭이 `B (중등도 권고)`를 그리는데(`evidence-inspector.tsx:155`) `RatingResponseDto.label`이 한국어다. 프로덕션 전량이 **6종뿐인 닫힌 어휘**(중등도 권고 1242 · 약한 권고 1017 · 전문가 합의 권고 132 · 강한 권고 99 · 권고하지 않음 12 · 권고 보류 6)라 문구표로 닫힌다. BE가 렌더하지 않는 이유는 이것이 **코퍼스에서 파싱된 값**이기 때문이다 — BE가 다시 해석하면 §18의 「추출된 사실은 원문 그대로 둔다」와 어긋난다. DTO 주석대로 체계가 문서마다 달라 새 코드가 올 수 있으므로 **모르는 값은 원문으로 남긴다**(`profileFieldLabel`과 같은 폴백). `code`(`B`)가 그대로 보이므로 대조는 깨지지 않는다 |
| 필드 라벨을 BE가 번역하는가 | **하지 않는다 — FE가 이미 한다.** `patientFactors`·`missingInformation`은 닫힌 어휘 9개이고 FE가 i18n 키로 매핑한다(관측). BE가 렌더하면 이중이 되고, **검증기가 대조하는 어휘**(`presentGuidanceProfileFields`)를 건드리면 구조화 항목이 전멸한다. BE가 소유하는 것은 자유 문장뿐이다 — 안전 경고와 폴백 `'근거 요약'` |
| 섹션 경로 번역을 어디에 두는가 | **`evidence_chunk_translations.section_path_translated` — 신규 테이블 없음.** §42가 `title_translated`에 내린 비정규화 판단을 그대로 따른다(「같은 값이 반복되지만 655행 규모에서 대가가 없고 조인이 늘지 않는다」). 섹션은 67개라 번역 비용이 청크의 1/10이다 |
| 지침 목록 제목(§`GET /guidelines`) | **기존 `title_translated`를 재사용 — 새 컬럼 0.** §42 주석이 이미 이 컬럼을 「제목 번역의 원천」이라 부른다. 청크 번역이 없는 지침은 키 부재로 닫혀 원문이 표시된다 |
| 가이던스 jsonb 인용의 번역 | **백필하지 않는다 — 이미 저장돼 있다**(영문 3건 6인용 전부). `GuidanceCitationJson`에 선언만 하면 계약에 드러난다. 과거 ko 행에는 없으며 키 부재로 닫힌다 |
| 폴백 경로 | **인용 번역을 읽는다.** 지금 0건이라 화면에 안 보이지만, 구조화가 상한을 넘는 순간 검토 항목이 통째로 한국어가 된다 — 관측되지 않는 경로라 더 조용히 깨진다 |

**위험.** ⑴ 구조화 언어가 갈리면 저장 텍스트가 영어로 **굳어 되돌릴 수 없다** — §42가 답변에
대해 감수한 것과 같은 성질이다. ⑵ `section_path_translated`는 배치 재실행으로 채워지며
(655행 ≈ $0.3), 그전까지는 키 부재라 화면이 원문으로 폴백한다 — 고장이 아니라 범위다.
⑶ 영문 참고안 표본이 3건뿐이라 「폴백은 안 난다」로 읽으면 안 된다.
⑷ **§42가 동결한 FE 기준 33·34·35의 전제가 「영문 화면」에서 「영문 응답 메시지」로 바뀐다.**
그 테스트들이 UI 토글로 언어를 세팅하고 있으면 깨지는데, 이는 회귀가 아니라 **의도된 전환**이다 —
재동결 시 이 문단을 근거로 기대값을 옮긴다. ⑸ 한국어 UI 사용자가 영문 질의를 한 번 하면 그
메시지 블록만 영어로 서는데, 이는 설계된 동작이지 버그가 아니다(판단표 「어디까지가 내용물인가」).

## 범위 (엔드포인트)

**신규·삭제 엔드포인트 없음.** 계약 변경은 전부 additive다.

| API | 변경 | 참조 |
|---|---|---|
| `GET /evidence/{evidenceId}` | `?lang=` 쿼리. `EvidenceDetailResponseDto`에 `recommendationTextTranslated?`·`sectionPathTranslated?` | §7 |
| `GET /guidelines` | `?lang=` 쿼리. `GuidelineSummaryResponseDto`에 `titleTranslated?` | §7 |
| `GET /conversations/{id}/messages` · SSE | `MessageResponseDto`에 `responseLang?`. `AnswerCitationResponseDto`에 `sectionPathTranslated?` | §8 |
| `GET /clinical-guidance/{guidanceId}` · `POST …/reviews` | `GuidanceCitationJson`에 `quoteTranslated?`·`titleTranslated?`·`sectionPathTranslated?` 선언. 문구가 언어별로 렌더 | §7 |

**`sectionPathTranslated`가 세 DTO에 붙는 이유**: 펼침 헤더의 섹션 경로가 세 경로에서 각각 다른
DTO로 온다 — 스트림 근거는 `EvidenceDetail`(`evidence-inspector.tsx:149`), 저장된 인용은
`AnswerCitation`(`assistant/page.tsx:45` 어댑터), 참고안은 `GuidanceCitationJson`
(`guidance-card.tsx:116`). 하나만 채우면 나머지 두 화면에서 그대로 한국어가 남는다.

`pnpm openapi:export` diff가 **위 여덟 필드 + 두 쿼리 파라미터의 추가뿐**이어야 한다(§1 contract 테스트가 지킨다).

| 진입점 (BE) | 변경 |
|---|---|
| `guideline.repository.ts` | `findEvidenceDetail`에 `evidence_chunk_translations` leftJoin(`lang` 조건) — `listCitationDetails`의 기존 조인과 같은 모양 |
| `guideline.service.ts` · `evidence.controller.ts` · `guideline.controller.ts` | 언어 인자 관통. `toEvidenceDetail`·`toCitationDto`의 언어 인자를 **선택에서 필수로** — 안 넘기면 조용히 한국어가 되는 것이 이 결함의 구조적 원인이다 |
| `guideline.mapper.ts` | `recommendationTextTranslated`(= `excerptTranslated`와 같은 원천) · `sectionPathTranslated` · `toGuidelineSummary`의 `titleTranslated` |
| `guidance-prompt.ts` | 규칙 7을 언어 분기. `GUIDANCE_PROMPT_VERSION`이 `guidance-v2` / `guidance-v2-en`. 용어집(`renderTermbase()`)을 프롬프트에 싣는다 |
| `guidance-structurer.port.ts` 외 2 | `GuidanceStructureInput`에 `lang`. openai·fake 구현 반영 |
| `clinical-guidance-composer.service.ts` | 안전 경고·`'근거 요약'` 문구표. 폴백이 `titleTranslated`·`quoteTranslated`를 읽는다 |
| `clinical-guidance.mapper.ts` · `.service.ts` · `.repository.ts` | 렌더 시점 언어 관통 — `messages.response_lang` 조인 |
| `clinical-guidance.schema.ts` | `GuidanceCitationJson`에 번역 필드 선언 |
| `conversation.mapper.ts` | `toMessageDto`가 `responseLang`을 싣는다(`MessageRow`가 이미 들고 있어 시그니처 불변 — §43과 같은 자리). `toCitationDto`에 `sectionPathTranslated` |
| `conversation-stream.service.ts` | 구조화·조립에 `responseLang` 전달 |
| `chunk-translator.service.ts` · `scripts/translate-chunks.ts` | `section_path_translated` 산출 |

| 진입점 (FE — `cure-agent-fe`) | 변경 |
|---|---|
| `evidence-full-text.tsx` | **`lang` prop 신설** — 콘텐츠 언어를 맥락에서 받는다. 없으면 `useUiLang()` 폴백(지침 탐색기). 앱 크롬 문구는 계속 `useUiLang()`을 쓰고, **근거에 밀착한 「미번역」 배지는 `lang`을 따른다**. `recommendationTextTranslated` 표시. **「한국어 원문 보기」 토글과 `originalShown` 상태를 제거**하고 원문 링크(`sourceUrl`)를 정본 도달 경로로 남긴다 — `showKoreanOriginal`·`hideKoreanOriginal` i18n 키가 미사용이 되므로 함께 지운다 |
| `assistant/page.tsx` | 메시지별 `responseLang`을 인용·근거 컴포넌트로 내린다 — **표시 언어의 원천이 여기서 바뀐다** |
| `evidence-inspector.tsx` · `guidance-card.tsx` | `useUiLang()` 대신 받은 `lang`으로 번역 표시를 판정. 펼침 헤더의 `sectionPathTranslated`·`titleTranslated`. **권고등급·근거수준 라벨 문구표**(6종 + 원문 폴백). `originalShown` 토글 제거 |
| `guideline-detail-panel.tsx` · `guideline-list-panel.tsx` | **UI 토글 유지** — 대화 맥락이 없다. 목록 제목의 `titleTranslated` |
| `guideline.api.ts` | `GET /evidence/{id}`·`GET /guidelines`에 `lang` 전달. **react-query 캐시 키에 lang 포함** — 키가 같으면 언어를 바꿔도 이전 응답이 남는다 |
| `stream-state.model.ts` 외 | 스트림 중에는 방금 보낸 `responseLang`을, 재조회에서는 `message.responseLang`을 쓴다 |

## Entity / 마이그레이션 변경분

- **`evidence_chunk_translations.section_path_translated text[]`** (nullable) — 섹션 경로의 번역.
  `null`이면 키 부재로 닫힌다. 신규 테이블 없음, 인덱스 없음(항상 청크 조인으로만 읽힌다).

## 추가 에러코드

없음 — 번역이 없는 것은 오류가 아니라 **필드 부재**다(§42와 동일). 잘못된 `lang` 값은 기존
쿼리 검증(`ValidationPipe`)이 막는다.

## 수용 기준 (= 동결할 시나리오, Definition of Done)

**한국어 경로는 한 바이트도 바뀌지 않는다**

1. `lang` 없는 `GET /evidence/{id}`가 오늘과 같은 응답이다 — 번역 키 없음 (BE e2e — 기존 클라이언트 형태 유지)
2. `responseLang=ko` 참고안의 `composerVersion`이 `guidance-v2` 그대로다 (BE 유닛)
3. ko 안전 경고 문장이 오늘과 **자구까지 같다** (BE 유닛 — 회귀)

**근거 전문이 요청 언어를 따른다**

4. `GET /evidence/{id}?lang=en`이 번역 있는 청크에 `excerptTranslated`·`translationModel`을 싣는다 (BE e2e)
5. 같은 응답의 `recommendationTextTranslated`가 `excerptTranslated`와 **같은 문자열**이다 (BE e2e — 권고 청크에서 두 원문이 동일하므로)
6. 번역이 없는 청크는 그 **키 자체가 빠진다** (BE e2e)
7. `source_content_hash`가 어긋나면 번역을 싣지 않는다 (BE e2e — stale)
8. `GET /guidelines?lang=en`이 번역 있는 지침에 `titleTranslated`를 싣는다 (BE e2e)

**섹션 경로가 헤더에서 언어를 가르지 않는다**

9. `sectionPathTranslated`가 원문과 **같은 길이의 배열**이다 (BE 유닛 — 원소 대응이 깨지면 경로가 뒤섞인다)
10. 잡이 `section_path_translated`를 채우고, 두 번 돌려도 행이 늘지 않는다 (BE e2e — 멱등)
11. `section_path_translated`가 `null`인 청크는 그 키가 응답에서 빠진다 (BE e2e)
12. **스트림 근거·저장된 인용·참고안 인용 세 경로 모두** `sectionPathTranslated`를 싣는다 (BE e2e — 하나만 채우면 나머지 두 화면이 한국어로 남는다)

**검토 항목이 생성 시점에 그 언어로 쓰인다**

13. `responseLang=en`이면 구조화 프롬프트의 언어 규칙이 영어다 (BE 유닛)
14. 영문 경로의 `GUIDANCE_PROMPT_VERSION`이 `guidance-v2-en`이고 `composerVersion`에 그 값이 기록된다 (BE e2e)
15. 구조화 프롬프트에 용어집이 실린다 (BE 유닛 — 답변과 같은 어휘)
16. 구조화가 실패·상한 초과하면 **폴백 항목이 `titleTranslated`·`quoteTranslated`를 쓴다** (BE e2e — 영문에서 폴백이 한국어로 떨어지지 않는다)
17. 인용 0건 폴백의 `'근거 요약'`이 영문에서 영어다 (BE 유닛)

**참고안 재조회가 저장된 언어를 따른다**

18. `GET /clinical-guidance/{id}`가 **요청에 언어가 없어도** `messages.response_lang`의 언어로 문구를 렌더한다 (BE e2e)
19. 영문 참고안의 `safetyAlerts[].description`이 영어다 (BE e2e)
20. 같은 응답의 `considerations[].citations[]`에 `quoteTranslated`·`titleTranslated`가 실린다 (BE e2e — 계약 선언)
21. ko 참고안에는 번역 키가 실리지 않는다 (BE e2e)
22. `pnpm openapi:export` 재생성본이 커밋된 스펙과 같다 (BE — 기존 contract 테스트, 회귀)

**메시지가 자기 언어를 말한다** — 표시 언어의 원천

23. `GET /conversations/{id}/messages`의 각 메시지에 `responseLang`이 실린다 (BE e2e)
24. `responseLang`을 보내지 않고 만든 과거 메시지는 `ko`로 읽힌다 (BE e2e — 기본값 백필, §42 기준 3 계승)

**화면은 UI 토글이 아니라 질의 언어를 따른다**

25. **UI 토글이 한국어여도, `responseLang=en`인 메시지의 답변·인용·근거가 영어로 표시된다** (FE 유닛 — 이 스텝의 핵심. §42 기준 33·34의 전제를 「영문 화면」에서 「영문 응답 메시지」로 옮긴다)
26. **UI 토글을 바꿔도 이미 받은 메시지의 내용물 언어가 바뀌지 않는다** (FE 유닛 — 토글은 앱 크롬만 바꾼다)
27. 한 대화에 ko·en 메시지가 섞이면 **각 블록이 자기 언어로** 표시된다 (FE 유닛)
28. 근거에 밀착한 「미번역」 배지가 **콘텐츠 언어**를 따른다 (FE 유닛 — 경계 선언은 콘텐츠 편이다)
29. 「인용 근거」 탭 이름·검토 폼·입력창·예시 질의문은 **UI 토글**을 따른다 (FE 유닛 — §42 기준 30·31 유지)
30. 지침 탐색기(`/guidelines`)는 대화 맥락이 없으므로 **UI 토글**을 따른다 (FE 유닛)
31. 영문 메시지의 펼침 헤더에 한국어 섹션 경로가 없다 (FE 유닛)
32. 권고문 원문 영역에 미번역 배지가 뜨지 않는다 — 번역이 있을 때 (FE 유닛)
33. `lang`이 react-query 캐시 키에 포함돼, 언어가 다르면 다시 조회한다 (FE 유닛 — 키가 같으면 이전 언어가 남는다)
34. 번역이 없는 근거에는 배지가 그대로 뜬다 (FE 유닛 — 경계는 계속 밝힌다)
35. 어느 카드에서도 **원문 링크로 한국어 정본에 도달할 수 있다** (FE 유닛 — §42 기준 35의 요구를 계승하되 충족 수단이 링크로 바뀐다)
36. 번역이 표시된 카드에 **「한국어 원문 보기」 토글이 없다** (FE 유닛 — 제거가 실제로 일어났음을 단언한다. 기준 35만으로는 토글이 남아 있어도 통과한다)
37. 영문 메시지의 인용 근거 탭에서 권고등급이 `B (Moderate recommendation)`처럼 **코드 + 영문 라벨**로 표시된다 (FE 유닛)
38. 문구표에 없는 등급 코드는 **원문 라벨 그대로** 표시된다 (FE 유닛 — 체계가 다른 지침이 들어와도 배지 자리가 비지 않는다)

fixture 규약: e2e는 **실 LLM·실 번역기·실 코퍼스를 부르지 않는다.** 번역기는 결정적 fake로
치환하고, 청크·섹션 번역은 **구조를 모방한 합성 텍스트**로 적재한다(§13). 기대값 원천은 이
문서의 관측표이며, 구현의 상수를 읽어 기대값을 만들지 않는다(§41·§42 fixture 규약과 같은 이유).

## Out of scope

- **필드 라벨의 BE 번역** — FE가 이미 닫힌 어휘로 번역한다(판단표). BE는 자유 문장만 소유한다
- **환자 프로필 값의 번역** — `진단명: 류마티스 관절염`의 값은 의료인이 입력한 **환자 데이터**다.
  기계 번역 대상이 아니며, 오역이 임상 정보를 바꾼다
- **전량 번역** — §42 Out of scope 그대로. 6주제 밖 근거는 한국어 원문만 보이고 화면이 경계를 밝힌다
- **저장된 참고안의 사후 번역** — 생성 시점 언어로 굳는다. ko로 만든 참고안을 en으로 다시 읽는
  기능은 만들지 않는다(§42가 답변에 대해 감수한 것과 같다)
- **`missingInformation`의 BE 렌더** — 위와 같은 이유로 FE 소유
- **지침 탐색기의 근거 발췌·섹션 경로** — `EvidenceSummaryResponseDto`는 손대지 않는다. 그 화면에서
  번역되는 것은 **목록 제목**과, 근거를 펼쳤을 때의 전문(`GET /evidence/{id}`)뿐이다. 목록 카드의
  요약 발췌는 한국어로 남는다 — 대화 맥락이 없는 탐색 화면이라 대조 요구가 약하다
- **인라인 원문 대조** — 「한국어 원문 보기」 토글을 없애고 원문 링크로 대체한다(판단표).
  화면 안에서 번역과 원문을 나란히 놓는 기능은 만들지 않는다
- **한국어 외 제3언어** — `ko`·`en` 둘뿐이다
