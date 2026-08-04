# 36. 회원탈퇴 — tombstone + 개설자 이양 + 마지막 구성원 클리닉 파기

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 테스트로 동결되며, 구현 중 수정할 수 없다.

## 목표

계정을 **탈퇴할 수 있게** 한다. 지금은 탈퇴 경로가 없어(`/auth`에 signup·refresh·logout·me뿐) 한번 만든
계정이 영구히 남는다. 탈퇴는 **개인정보를 즉시 파기**하되 행은 남기고(tombstone), 남은 구성원이 없으면
클리닉 전체를 §34의 유예 크론에 태워 파기한다. 개설자가 떠날 수 있도록 **권한 이양**을 함께 만든다 —
§35가 Out of scope로 미룬 자리다.

## 판단 근거 (2026-08-04 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 탈퇴자 행을 지우는가 | **지우지 않는다 — tombstone**(개인정보 필드만 익명화). `clinicians`를 참조하는 FK가 **8개이고 그중 5개가 notNull**이다(아래 실측). 물리 삭제하려면 다섯을 전부 nullable로 바꿔야 하는데, `answer_feedbacks`·`guidance_reviews`는 **「누가 평가·검토했는가」가 기록의 본질**이라 NULL이 되면 감사 기록이 무의미해진다. 게다가 §35로 대화가 클리닉 공유 자산이 됐으므로 탈퇴자의 대화를 지우면 **남은 동료가 보던 기록이 사라진다** |
| 재가입을 허용하는가 | **허용한다 — 식별자를 익명화한다.** `uq_clinicians_email`·`uq_clinicians_oauth`가 tombstone을 막으므로 둘 다 익명값으로 덮는다. 원본을 남겨 재가입만 막는 선택은 **탈퇴했는데 서버가 이메일·소셜 ID를 계속 보관**하는 것이라 탈퇴의 취지와 어긋난다. 익명화는 파기 의무와 재가입 허용을 동시에 만족하며, 부수 효과로 같은 소셜 계정의 재로그인이 자연히 **신규 가입 흐름**으로 흐른다(§4.2 계정 동일성이 provider+providerId이므로) |
| 개설자가 떠나려면 | **이양 API를 만든다.** owner를 NULL로 두면 그 클리닉은 **영구히 초대를 발급할 수 없는 잠긴 상태**가 되고(§35는 발급·조회·취소 전부를 owner에 묶었다), 자동 이양은 남은 사람이 동의 없이 권한을 받는 데다 다중 구성원 클리닉이 프로덕션에 **0개**라 검증 표본조차 없다. 남은 구성원이 있는 개설자의 탈퇴는 **409로 막고** 이양을 요구한다 |
| 이양 대상을 어떻게 고르는가 | **구성원 목록 API를 함께 만든다.** 지금은 「우리 클리닉에 누가 있는가」를 물을 방법이 **0건**이라 이양 API만으로는 대상 id를 알 수 없다. 목록은 **구성원 전원**에게 연다 — 환자·대화를 전원 공유하면서(§35) 동료가 누구인지 모르는 상태가 더 이상하다 |
| 마지막 구성원이면 | **클리닉 전체를 파기한다.** 접근자가 0명이 된 환자·대화가 무기한 남는 것은 건강정보 보관으로 정당화되지 않는다(§4.5 — 민감정보). 프로덕션 3계정이 **전부 여기 해당**한다(전 클리닉 1인) |
| 즉시 파기인가 유예인가 | **둘을 나눈다.** 개인정보(이메일·면허번호·이름·소셜 ID)는 **요청 즉시** 익명화한다 — 파기 의무의 본체이고 미룰 이유가 없다. 반면 클리닉 데이터(환자·대화·가이던스)는 **§34의 유예 크론**에 태운다: 오삭제를 되돌릴 여지가 필요하고, 실측상 한 클리닉 파기가 메시지 112·스냅샷 9행에 이르는 다단 역순 삭제라 요청 트랜잭션 밖으로 밀어내야 한다(§34가 같은 이유로 확립한 구조를 그대로 계승한다) |

## 실측 조사 (2026-08-04, 프로덕션 DB + 코드)

| 확인 항목 | 실측 |
|---|---|
| 탈퇴 API | **0건** — `/auth`는 signup·refresh·logout·me뿐 |
| 구성원 목록·이양 API | **0건** (clinician 도메인의 컨트롤러는 초대 2개뿐) |
| `clinicians` 참조 FK | **8개 전부 NO ACTION** — §35가 3개를 늘렸다(clinics.owner_clinician_id · clinic_invitations.invited_by · accepted_by) |
| 그중 **notNull** | **5개** — auth_sessions · conversations · answer_feedbacks · guidance_reviews · **clinic_invitations.invited_by** |
| nullable | 3개 — clinics.owner_clinician_id · guideline_jobs.requested_by · clinic_invitations.accepted_by |
| `clinicians` unique | `uq_clinicians_email(email)` · `uq_clinicians_oauth(provider, providerId)` |
| `clinics` 참조 FK | **2개뿐** — `clinicians.clinic_id` · `clinic_invitations.clinic_id` |
| **`patients`·`conversations`·`clinical_guidances`의 `clinic_id`** | **FK 0건** — 컬럼은 들고 있으나 제약이 없다 |
| clinic : clinician | 3 : 3, 각 1명 — **전원이 개설자이자 마지막 구성원**. 다중 구성원 클리닉 0개 |
| 구성원별 자산 | ADMIN: 대화 42 · 검토 6 · 세션 **74** · 잡 10 / 나머지 둘: 대화 0~1 · 세션 1~3 |
| 클리닉 A 파기 연쇄 | 환자 5 · 대화 42 · 메시지 **112** · 스냅샷 9 · 가이던스 8 · 검토 6 |
| 세션 폐기 경로 | `revokeFamily(familyId)` — **family 단위**다. `logout`은 현재 세션의 family 하나만 끈다 |

두 행이 설계를 결정한다.

**⑴ `patients`·`conversations`·`clinical_guidances`에 clinic FK가 없다** — DB는 클리닉 삭제를 막아주지
않으므로 이 세 계열은 **앱이 명시적으로 먼저 지워야** 고아가 남지 않는다. §34의 고아 스냅샷 1건이
삭제 순서를 결정했던 것과 같은 자리이며, 이번에는 **제약이 없다는 사실 자체**가 위험이다.

**⑵ `clinics.owner_clinician_id ↔ clinicians.clinic_id`가 순환 FK다** — clinicians를 지우려면 owner가
그를 가리키지 않아야 하고, clinics를 지우려면 clinicians가 없어야 한다. **owner를 NULL로 끊는 UPDATE가
파기 순서에 반드시 들어간다.**

## 범위 (엔드포인트)

| API | Request | Response data | 참조 |
|---|---|---|---|
| GET /clinic/members | 없음 | ClinicMemberResponseDto[] | §5.8 |
| POST /clinic/owner/transfer | TransferClinicOwnerRequestDto | null | §5.8 |
| DELETE /auth/me | 없음 | null | §4.2 |

상태 코드는 **200 + null 봉투**다(이양·탈퇴) — §34가 확립한 관행과 같고 204는 §10.1 봉투 규약과 어긋난다.
구성원 목록은 **전원**, 이양은 **개설자 전용**(`ClinicOwnerGuard` 재사용)이다.

| 진입점 | 변경 |
|---|---|
| `clinic-member.controller.ts` (신규) | 목록·이양. 이양만 `@UseGuards(ClinicOwnerGuard)` |
| `clinician.repository.ts` | `listMembers(clinicId)`(tombstone 제외) · `countActiveMembers(clinicId)` · `findMemberInClinic(clinicId, id)` · `anonymize(id, at)` |
| `auth.controller.ts` · `auth.service.ts` | `DELETE /auth/me` → `withdraw(principal)`. 순서는 **⑴ 개설자·잔여 구성원 판정 → ⑵ tombstone 익명화 → ⑶ 마지막이면 `clinics.deletedAt` → ⑷ 전 세션 폐기**. 판정이 먼저다: 409로 끝날 요청이 개인정보를 먼저 지우면 되돌릴 수 없다 |
| `auth-session.repository.ts` | `findFamilyIdsByClinician(id)` · `revokeAllByClinician(id, at)` — 탈퇴는 **전 family**를 끈다. `logout`이 쓰는 단일 family 폐기로는 다른 기기 세션이 살아남는다(실측 최대 74세션) |
| `token-denylist.service.ts` 호출부 | 폐기한 **모든 family**를 denylist에 올린다 — 그러지 않으면 TTL이 남은 access 토큰으로 탈퇴 후에도 요청이 통과한다(§4.3) |
| `data-purge.service.ts` · `repository` | 클리닉 파기 추가. 기존 `purgeConversations`·`purgePatients`를 **재사용**하고 그 위에 초대·세션·구성원·클리닉을 얹는다. 락·배치 상한·fail-closed는 §34 구조 그대로 |
| `metrics.service.ts` | `clinician_withdrawal_total{outcome=withdrawn\|blocked}` · `data_purge_total{target=clinic}` 라벨 추가 |
| `docs/architecture.md` | §4.2에 `DELETE /auth/me`, §5.8에 목록·이양, §9에 `deletedAt` 2건 |

**클리닉 파기 순서** (유예 경과분, 한 tx):

```
① 대화 계열   — §34 purgeConversations 재사용 (guidance_reviews → clinical_guidances
                 → message_citations → generation_runs → answer_feedbacks → messages → conversations)
② 환자 계열   — §34 purgePatients 재사용 (patient_profile_snapshots → patients)
③ clinic_invitations
④ auth_sessions
⑤ clinics.owner_clinician_id = NULL   ← 순환 FK를 끊는다. 없으면 ⑥이 실패한다
⑥ clinicians
⑦ clinics
```

①②는 FK가 막아주지 않으므로(실측 ⑴) **clinic_id 기준으로 직접 산출**한다 — 대화·환자의 `deletedAt`
유무와 무관하게 그 클리닉의 전건이 대상이다.

## Entity / 마이그레이션 변경분 (마이그레이션 **0019**)

- `clinicians.deleted_at` timestamptz NULL — tombstone 표시이자 목록 필터. 부분 인덱스
  `idx_clinicians_deleted on (deleted_at) where deleted_at is not null`
- `clinics.deleted_at` timestamptz NULL — 파기 예약. 부분 인덱스 `idx_clinics_purge` 동형
- **익명화는 컬럼 신설이 아니라 기존 컬럼 덮어쓰기다** — `email`·`oauth_provider_id`는 unique가 걸려
  있어 값을 비울 수 없고, id를 섞은 결정적 값(`deleted-{clinicianId}@deleted.invalid` 형태)으로 덮으면
  충돌 없이 유일성이 유지된다. `display_name`·`license_number_encrypted`도 함께 덮는다

## 추가 에러코드

- `CLINIC_OWNER_MUST_TRANSFER` (409) — 「개설자는 먼저 다른 구성원에게 권한을 넘겨야 탈퇴할 수 있습니다.」
- 이양 대상이 같은 클리닉의 살아 있는 구성원이 아니면 기존 `NOT_FOUND`(§4.4 스코프 은닉)로 충분하다

## 수용 기준 (= 동결할 시나리오, Definition of Done)

**구성원 목록**

1. `GET /clinic/members`가 같은 클리닉 구성원을 반환한다 — 개설자와 합류자가 모두 있다 (e2e)
2. 타 클리닉 구성원은 목록에 **없다** (e2e — §4.4)
3. 탈퇴한 tombstone은 목록에 **없다** (e2e)
4. 개설자가 **아닌** 구성원의 목록 조회도 **200**이다 (e2e — 전원 공개)

**개설자 이양**

5. 개설자의 이양 → 200이고 `clinics.owner_clinician_id`가 지정한 대상으로 바뀐다 (e2e)
6. 이양 후 **이전** 개설자의 초대 발급 → **403** (e2e — 권한이 실제로 떠났다)
7. 이양 후 **새** 개설자의 초대 발급 → **201** (e2e — 권한이 실제로 도착했다)
8. 개설자가 아닌 구성원의 이양 시도 → 403 (e2e)
9. **타 클리닉** 구성원에게 이양 → 404이고 `owner_clinician_id`가 **변하지 않는다** (e2e — 양성 대조군 포함)
10. 탈퇴한 tombstone에게 이양 → 404 (e2e)
11. 자기 자신에게 이양 → 200이고 owner가 그대로다 (e2e — 멱등)

**탈퇴 — 일반 구성원**

12. `DELETE /auth/me` → 200 + null 봉투 (e2e)
13. `clinicians.deleted_at`이 채워진다 (e2e)
14. `email`이 원본과 **다른** 값으로 덮인다 (e2e)
15. `oauth_provider_id`가 원본과 **다른** 값으로 덮인다 (e2e)
16. `display_name`이 원본과 **다른** 값으로 덮인다 (e2e)
17. `license_number_encrypted`가 원본과 **다른** 값으로 덮인다 (e2e)
18. 탈퇴자의 `auth_sessions`가 **전부** `revoked_at`을 갖는다 — 여러 기기 로그인을 만든 뒤 단언한다 (e2e)
19. 탈퇴 직후 그 계정의 기존 access 토큰으로 보호 API 호출 → **401** (e2e — denylist)
20. 탈퇴자가 만들었던 대화를 **남은 동료가 여전히 200으로 조회**한다 (e2e — 공유 자산은 사라지지 않는다)
21. 탈퇴자가 남긴 `answer_feedbacks`·`guidance_reviews` 행이 **잔존한다** (e2e — 감사 기록 보존)
22. 같은 소셜 계정으로 다시 로그인하면 **신규 가입 티켓**이 발급된다 (e2e — 재가입 가능)
23. 재가입으로 만들어진 계정은 탈퇴 전과 **다른 clinicianId**를 갖는다 (e2e — 되살아나는 것이 아니다)

**탈퇴 — 개설자**

24. 남은 구성원이 있는 개설자의 탈퇴 → **409** `CLINIC_OWNER_MUST_TRANSFER` (e2e)
25. 그 409 요청이 `clinicians.deleted_at`을 **채우지 않는다** (e2e — 판정이 익명화보다 앞선다)
26. 그 409 요청이 `email`을 **덮지 않는다** (e2e — 되돌릴 수 없는 파기가 먼저 일어나지 않는다)
27. 이양을 마친 뒤 같은 사람의 탈퇴 → **200** (e2e)

**탈퇴 — 마지막 구성원**

28. 마지막 구성원(=개설자)의 탈퇴 → **200**이고 409가 아니다 (e2e — 넘길 상대가 없으면 막지 않는다)
29. 그 요청이 `clinics.deleted_at`을 채운다 (e2e)
30. 구성원이 둘일 때는 한 명이 나가도 `clinics.deleted_at`이 **null로 남는다** (e2e)

**파기 크론**

31. 유예 경과한 클리닉의 `clinics` 잔존 **0** (e2e)
32. 그 클리닉의 `clinicians` 잔존 **0** (e2e — ⑤의 owner NULL 처리가 없으면 여기서 FK로 실패한다)
33. 그 클리닉의 `patients`·`conversations` 잔존 **0** (e2e — clinic FK가 없어 앱이 직접 지운 결과)
34. 그 클리닉의 `clinic_invitations` 잔존 **0** (e2e)
35. 유예 **미경과** 클리닉은 파기되지 않는다 (유닛 — 주입 시각. §34 기준 14와 같은 이유: SQL `now()`로 계산하면 시각 주입이 성립하지 않는다)
36. 삭제 예약되지 않은 클리닉은 크론이 건드리지 않는다 (e2e)

fixture 규약: 같은 클리닉 2인은 §35의 `joinByInvitation` 헬퍼로 만든다 — DB 직접 INSERT 금지(§35
fixture 규약과 같은 이유). 다기기 세션(기준 18)은 같은 계정으로 `socialCallback`을 반복해 합성한다.

## Out of scope

- **탈퇴 철회·계정 복구** — `deletedAt`은 §34와 같이 「파기 예약」이지 「복구 유예」가 아니다. 익명화는
  즉시이므로 되돌릴 대상 자체가 없다
- **구성원 강제 제거**(개설자가 남을 내보내기) — 탈퇴는 본인 의사다. 타인 계정 처분은 권한 모델이
  더 필요하다
- **소속 이동** — §35가 거부로 확정했고 그대로 유지한다
- **탈퇴 사유 수집·설문** — 별도 테이블이 필요하며 이번 범위 밖이다
- **`guideline_jobs.requested_by` 정리** — nullable이라 tombstone으로 충분하다. 잡 이력은 플랫폼 자산이라 클리닉 파기와 함께 지우지 않는다
- FE 탈퇴 확인 UX·이양 대상 선택 화면 — 별도 레포 스펙
