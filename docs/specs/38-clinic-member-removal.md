# 38. 구성원 강퇴 — 무소속 전환 + 재온보딩

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 테스트로 동결되며, 구현 중 수정할 수 없다.

## 목표

개설자가 구성원을 **내보낼 수 있게** 한다 — §35 초대의 반대 방향이다. 지금은 합류만 있고 이탈은
본인 탈퇴(§36)뿐이라, 그만둔 직원이나 잘못 초대한 사람이 클리닉의 환자·대화에 무기한 접근한다.
강퇴는 **소속만 끊는다** — 계정도 개인정보도 그 사람의 것이므로 개설자가 파기하지 않는다. 소속이
끊긴 계정은 세션을 가질 수 없고, 다시 로그인하면 **온보딩 화면**으로 흘러 새 한의원을 열거나 다른
초대로 합류한다. §37이 Out of scope로 미룬 자리다.

## 판단 근거 (2026-08-05 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 「빼낸다」가 무엇인가 | **무소속 전환 + 재온보딩.** `clinicians.clinic_id`를 nullable로 풀고 NULL로 끊는다. tombstone(=강제 탈퇴)은 **개설자가 남의 이메일·면허번호를 비가역으로 파기**하는 것이라 오강퇴를 되돌릴 수 없고, §36이 「타인 계정 처분은 권한 모델이 더 필요하다」로 그은 선을 정면으로 넘는다. 파기는 정보주체의 권리행사(§36)이지 제3자가 대신 행사할 수 있는 것이 아니다 |
| 새 개인 클리닉으로 옮기지 않는 이유 | **클리닉명 변경 API가 0건이다**(실측). 서버가 지어준 이름이 영구 고정되고, 개설한 적 없는 한의원의 개설자가 되며, 아무도 안 쓰는 빈 클리닉이 계속 쌓인다(§36 파기는 마지막 구성원 **탈퇴** 시에만 돈다) |
| 무소속이 전 시스템을 흔들지 않는가 | **흔들지 않는다 — 무소속은 「세션을 가질 수 없는 상태」로 정의한다.** 로그인·세션 복구 경로가 이미 `innerJoin(clinics)`라(`clinician.repository.ts:127`·`:152`) clinic이 없으면 둘 다 null을 돌려준다. 즉 NOT NULL만 풀면 무소속 계정은 **자동으로 로그인 불가**가 되고, `ClinicianPrincipal.clinicId`(36개 사용처)·JWT claim·§4.4 스코프 가정은 **하나도 바뀌지 않는다**. 무소속은 「온보딩 직전」에만 존재하는 상태다 |
| 재온보딩이 선택인가 필수인가 | **필수다.** `uq_clinicians_oauth`가 계정 동일성의 유일한 제약이므로(§37), 무소속 계정을 신규 가입으로 흘리면 같은 `(provider, providerId)`로 두 번째 insert가 일어나 **unique 위반 500**이 난다. 콜백이 무소속 회원을 **기존 clinicianId를 실은 티켓**으로 흡수해야만 성립한다 |
| 재온보딩에 이메일을 다시 요구하는가 | **요구하지 않는다.** §4.2가 「이메일은 신규 가입 시에만 필수이며 기존 회원은 이메일 미동의 상태로도 로그인된다」로 이미 규정했고, 무소속 회원도 기존 회원이다. 티켓의 이메일은 제공자가 아니라 **DB의 기존 값**에서 온다 — `auth.service.ts:75`의 `AUTH_OAUTH_EMAIL_MISSING`은 신규에만 남는다 |
| 강퇴 이력을 남기는가 | **`clinic_member_removals`에 남긴다.** 소속을 끊으면 `clinicians`에서 그 클리닉의 흔적이 사라져, 강퇴당한 사람도 개설자도 근거를 볼 수 없다. §35가 「누가 언제 합류했는가가 남아야 한다」로 초대를 TTL 소멸형이 아닌 테이블로 둔 것과 같은 이유이며, 강퇴는 **타인 계정 처분**이라 분쟁 소지가 초대보다 크다 |
| 강퇴 대상이 발급했던 유효 초대는 | **함께 취소한다.** 토큰 원문은 발급자만 갖고 있으므로(§5.8 — 목록에 실리지 않는다), 남겨두면 내보낸 사람이 손에 쥔 링크로 제3자가 그 클리닉에 들어온다. 개설자가 목록에서 직접 취소할 수는 있으나 **어느 것이 그 사람 것인지 놓치기 쉽다** — 이양 후 강퇴 경로에서 실재한다 |
| 개설자가 자신을 내보내면 | **409로 막는다.** owner가 NULL이면 그 클리닉은 영구히 초대를 발급할 수 없는 잠긴 상태가 되고(§35), 이는 §36이 `CLINIC_OWNER_MUST_TRANSFER`로 막은 것과 **같은 사고**다. 이양 API의 자기 자신 지정은 결과가 같아 멱등 200이었지만(§36 기준 11), 강퇴는 결과가 다르므로 멱등으로 볼 수 없다 |

## 실측 조사 (2026-08-05, 프로덕션 DB + 코드)

| 확인 항목 | 실측 |
|---|---|
| 구성원 제거 API | **0건** — `/clinic`은 `members`(GET)·`owner/transfer`(POST)·`invitations` 3종뿐 |
| clinics : clinicians | **3 : 4** — 활성 클리닉 2 · 파기 예약 1 / 활성 clinician 3 · tombstone 1 |
| **다중 구성원 클리닉** | **1개** — 개설자(ADMIN·GOOGLE)와 §35 초대로 합류한 MEMBER(NAVER, 2026-08-04). **강퇴 대상이 실재한다** |
| 그 합류자의 자산 | 대화 0 · 피드백 0 · 검토 0 · 세션 **2(전부 살아 있음)** · family 1 |
| 개설자의 자산 | 대화 42 · 검토 6 · 세션 82(살아 있는 31) · family **21** · 잡 10 |
| `clinicians.clinic_id` | **NOT NULL** — 「소속 없음」을 표현할 수단이 없다 |
| 로그인·세션 복구 조인 | `findByOAuthAccount`(`:127`)·`findById`(`:152`) 둘 다 **`innerJoin(clinics)`** |
| `clinicians` 참조 FK | **8개 전부 NO ACTION**, 그중 notNull 5(auth_sessions·conversations·answer_feedbacks·guidance_reviews·clinic_invitations.invited_by) |
| `clinics` 참조 FK | **2개뿐** — `clinicians.clinic_id` · `clinic_invitations.clinic_id` |
| 클리닉명 변경 API | **0건** — `update(clinics)`는 owner 지정·파기 예약·파기 세 곳뿐 |
| `patients`·`clinical_guidances`의 clinician 컬럼 | **0개** — 개인에 귀속되는 클리닉 자산이 없다. clinician에 붙는 것은 `conversations.clinician_id`(작성자)·`answer_feedbacks`·`guidance_reviews` 셋뿐 |
| 유효 초대 | **1건 PENDING**(만료 2026-08-11) — 3건 모두 개설자 발급, 수락 1 · 취소 2 |
| FE 자리 | `/profile`의 `clinic-members-panel.tsx`에 「함께 일하는 사람」 목록과 이양 버튼이 이미 있다 |

두 행이 설계를 결정한다. **⑴ NOT NULL과 innerJoin이 함께 있다** — 그래서 **NOT NULL만 풀면 무소속
계정의 로그인 차단이 공짜로 따라온다.** 이 스펙이 nullable을 택할 수 있는 근거이자, 무소속을 「세션
없는 상태」로 정의하는 근거다. **⑵ 클리닉명 변경 API가 0건이다** — 서버가 클리닉을 대신 개설해주는
안을 기각한다. 지어준 이름을 당사자가 고칠 방법이 없다.

## 범위 (엔드포인트)

| API | Request | Response data | 참조 |
|---|---|---|---|
| DELETE /clinic/members/{clinicianId} | 없음 | null | §5.8 |

**신규 엔드포인트는 하나다.** 재온보딩은 새 경로가 아니라 기존 `GET /auth/oauth/{provider}/callback` →
`POST /auth/signup`의 **분기 확장**이다 — 요청·응답 스키마가 불변이라 `pnpm openapi:export` 결과가
달라지지 않아야 한다(contract 테스트가 지킨다). 상태 코드는 **200 + null 봉투**다(§34·§36 관행, 204는
§10.1 봉투 규약과 어긋난다).

| 진입점 | 변경 |
|---|---|
| `clinic-member.controller.ts` | `@Delete('members/:clinicianId')` 추가. `@UseGuards(ClinicOwnerGuard)` — 이양과 같은 게이트다 |
| `clinic-member.service.ts` | `remove(principal, clinicianId)`. 순서는 **⑴ 대상 검증 → ⑵ 자기 자신 차단 → ⑶ familyIds 조회 → ⑷ tx(이력 insert → `clinic_id` NULL → 발급한 유효 초대 취소 → 전 세션 폐기) → ⑸ denylist**. 이력을 먼저 넣는 이유는 `clinic_id`를 NULL로 만든 뒤에는 그 사람이 어느 클리닉에 있었는지 행에서 읽을 수 없기 때문이다 |
| `clinician.repository.ts` | `detachFromClinic(clinicId, clinicianId)`(조건부 UPDATE — 0행이면 경합이므로 404) · `findByOAuthAccount`의 `innerJoin` → **`leftJoin`**. `findById`의 innerJoin은 **남긴다** — 무소속 계정에 세션이 발급되지 않음을 조인이 강제하는 안전망이다 |
| `clinic-invitation.repository.ts` | `revokeAllByInviter(clinicId, inviterId, at)` — 미수락·미취소분만 덮는다. 수락된 초대는 건드리지 않는다(§5.8 「합류가 취소보다 우선」) |
| `clinic-member-removal.repository.ts` (신규) | `insert`. 조회 API는 없다(Out of scope) |
| `auth.service.ts` `socialLogin` | clinician은 있는데 clinic이 없으면 **재온보딩 티켓**을 발급한다(`SIGNUP_REQUIRED`). 이메일 필수 검사는 이 분기를 타지 않는다 — 티켓의 이메일은 DB의 기존 값이다 |
| `oauth-ticket.service.ts` | `OAuthTicketPayload`에 `clinicianId?: string` 추가 |
| `auth.service.ts` `completeSignUp` | 티켓에 `clinicianId`가 있으면 insert 대신 **UPDATE**(`clinicId`·`displayName`·`licenseNumberEncrypted`). `email`·`oauthProvider`·`oauthProviderId`·`role`·`id`는 건드리지 않는다. **클리닉 개설·초대 합류 두 분기 모두**에서 성립해야 한다 |
| `auth-session.repository.ts` | `findFamilyIdsByClinician`·`revokeAllByClinician` **재사용** — §36이 만든 그대로다. 강퇴도 탈퇴와 같이 **전 family**를 끈다(실측 최대 21 family) |
| `data-purge.repository.ts` `purgeClinics` | `clinic_member_removals` 삭제를 ⑥ 이전에 넣는다. **두 축으로 지운다** — `clinic_id ∈ 대상` **그리고** `removed_clinician_id`·`removed_by_clinician_id ∈ 그 클리닉 구성원. 전자만 지우면, 강퇴당해 다른 클리닉으로 옮긴 사람의 새 클리닉이 파기될 때 **옛 클리닉에 남은 이력 행이 그를 참조해 FK로 실패한다** |
| `metrics.service.ts` | `clinic_member_removal_total{outcome=removed\|blocked}`. 자동 취소된 초대는 기존 `clinic_invitation_total{outcome=revoked}`에 함께 센다 — 주체가 달라도 초대의 종말은 같고, 라벨을 쪼개면 §35 대시보드가 갈린다 |
| `docs/architecture.md` | §4.2 콜백 분기에 「소속 없는 기존 회원 → 재온보딩 티켓」과 signup의 계정 재사용, §5.8에 강퇴 규약, §9에 `ClinicMemberRemovalEntity`와 `ClinicianEntity.clinicId`의 nullable 의미 |

## Entity / 마이그레이션 변경분 (마이그레이션 **0021**)

- `clinicians.clinic_id` **DROP NOT NULL**. FK는 유지된다 — nullable FK는 §35 `owner_clinician_id`의
  선례가 있다. 제약을 **푸는** 방향이라 기존 행이 위반할 수 없다(§37 실측 ⑶과 같은 논리)
- `clinic_member_removals` (신규): `id` · `clinic_id` → clinics notNull · `removed_clinician_id` →
  clinicians notNull · `removed_by_clinician_id` → clinicians notNull · baseColumns(`created_at`이
  강퇴 시각). 인덱스 `idx_clinic_member_removals_clinic (clinic_id, created_at desc)` — §35 초대 인덱스와 동형
- **unique를 걸지 않는다** — 같은 사람이 다시 초대받아 합류했다가 또 강퇴되는 것이 정상 경로다
- 클리닉 파기 때 **살아 있는 클리닉의 이력 행이 함께 사라질 수 있다**(위 두 축 삭제). 이는 감수하는
  손실이다 — 행위자가 물리 삭제되면 「누가」가 비어 감사 기록으로서 의미가 없다. §36이
  `answer_feedbacks`·`guidance_reviews`를 보존한 근거(「누가 평가했는가가 기록의 본질」)의 대우다
- 데이터 마이그레이션 **없음**

## 추가 에러코드

- `CLINIC_OWNER_CANNOT_REMOVE_SELF` (409) — 「개설자는 자신을 내보낼 수 없습니다. 떠나려면 먼저 다른
  구성원에게 권한을 넘기고 탈퇴해주세요.」 §36 `CLINIC_OWNER_MUST_TRANSFER`와 대칭이며 문구가 다음
  행동(이양→탈퇴)을 담는다
- 타 클리닉 구성원·tombstone 대상은 기존 `NOT_FOUND`로 충분하다 (§4.4 존재 은닉 — §36 이양과 같은 처분)
- 개설자 아닌 구성원의 강퇴 시도는 기존 `FORBIDDEN`(`ClinicOwnerGuard`)으로 충분하다

## 수용 기준 (= 동결할 시나리오, Definition of Done)

**강퇴 — 소속만 끊는다**

1. 개설자의 `DELETE /clinic/members/{id}` → **200 + null 봉투** (e2e)
2. 그 구성원의 `clinicians.clinic_id`가 **NULL**이 된다 (e2e — DB 직접 조회)
3. 강퇴당한 사람은 `GET /clinic/members` 목록에서 **사라진다** (e2e)
4. `clinicians.deleted_at`이 **null로 남는다** (e2e — 강퇴는 tombstone이 아니다)
5. `email`이 **원본 그대로**다 (e2e — 개설자는 남의 개인정보를 파기하지 않는다)
6. `license_number_encrypted`가 **원본 그대로**다 (e2e)
7. `display_name`이 **원본 그대로**다 (e2e)
8. `oauth_provider_id`가 **원본 그대로**다 (e2e — 계정 동일성이 보존되어 재온보딩이 성립한다)

**즉시 차단**

9. 강퇴 직후 그 사람의 기존 access 토큰으로 보호 API 호출 → **401** (e2e — denylist)
10. 그 사람의 `auth_sessions`가 **전부** `revoked_at`을 갖는다 — 여러 기기 로그인을 만든 뒤 단언한다 (e2e)
11. 강퇴 전에 받은 refresh 쿠키로 `POST /auth/refresh` → **401** (e2e)
12. 무소속 clinician에 대한 `findById`가 **null**을 돌려준다 (e2e — 리포지토리 직접 호출.
    denylist TTL이 지난 뒤에도 세션이 되살아나지 않게 막는 안전망이 innerJoin이다)

**권한·대상**

13. 개설자가 **아닌** 구성원의 강퇴 시도 → **403** (e2e)
14. **타 클리닉** 구성원 강퇴 → **404**이고 그 행의 `clinic_id`가 **변하지 않는다** (e2e — §4.4, 양성 대조군 포함)
15. 이미 탈퇴한 tombstone 강퇴 → **404** (e2e)
16. 개설자가 **자신**을 강퇴 → **409** `CLINIC_OWNER_CANNOT_REMOVE_SELF` (e2e)
17. 그 409 요청이 개설자의 `clinic_id`를 **바꾸지 않는다** (e2e — 판정이 UPDATE보다 앞선다)

**기록은 클리닉에 남는다**

18. 강퇴당한 사람이 만든 대화를 남은 구성원이 **여전히 200으로 조회**한다 (e2e — §5.7 공유 자산)
19. 그 대화의 `conversations.clinician_id`가 **강퇴당한 사람 그대로**다 (e2e — 작성자 기록은 접근 판정이 아니다, §4.4)
20. 강퇴당한 사람이 남긴 `answer_feedbacks`·`guidance_reviews` 행이 **잔존한다** (e2e — 감사 기록 보존, §36 기준 21과 같은 이유)

**강퇴 이력**

21. 강퇴 시 `clinic_member_removals`에 **1행**이 생긴다 (e2e)
22. 그 행의 `removed_by_clinician_id`가 **강퇴를 실행한 개설자**다 (e2e)
23. 그 행의 `clinic_id`가 **강퇴 시점의 클리닉**이다 (e2e — `clinicians.clinic_id`가 NULL이 된 뒤에도 남는다)
24. 같은 사람이 재합류 후 다시 강퇴되면 이력이 **2행**이 된다 (e2e — unique를 걸지 않았다)

**발급했던 초대의 처분**

25. 강퇴 대상이 발급한 **PENDING** 초대의 `revoked_at`이 채워진다 (e2e)
26. 그 토큰으로 프리뷰 → **404** `INVITATION_INVALID` (e2e)
27. **다른 사람이 발급한** PENDING 초대는 `revoked_at`이 **null로 남는다** (e2e — 양성 대조군)
28. 이미 수락된 초대의 `accepted_at`이 **변하지 않는다** (e2e — 합류가 취소보다 우선, §5.8)

**재온보딩 — 무소속에서 나가는 문**

29. 강퇴당한 사람의 소셜 재로그인 → **온보딩 티켓**이 발급된다 (e2e — 로그인되지 않는다)
30. 그 티켓 + `clinicName`으로 signup → **201** (e2e)
31. 재온보딩 후 `clinicianId`가 **강퇴 전과 같다** (e2e — 새 계정이 아니다)
32. 재온보딩으로 `clinicians` 총 건수가 **늘지 않는다** (e2e — insert가 아니라 UPDATE다)
33. 재온보딩된 계정의 `email`이 **강퇴 전 값 그대로**다 (e2e — 티켓이 DB의 기존 값을 쓴다)
34. 재온보딩으로 만든 클리닉의 `owner_clinician_id`가 **본인**이다 (e2e)
35. 이메일을 주지 않는 소셜 재로그인도 **티켓이 발급된다** (e2e — 신규였다면 `AUTH_OAUTH_EMAIL_MISSING`이다. §4.2 「기존 회원은 이메일 미동의로도」)
36. 강퇴당한 사람이 **초대 토큰**으로 재온보딩 → 201이고 `clinicId`가 초대한 클리닉과 **같다** (e2e — 오강퇴 복구 경로)
37. 그 초대 합류로도 `clinicians` 총 건수가 **늘지 않는다** (e2e)

**파기 크론 회귀**

38. 파기된 클리닉의 `clinic_member_removals` 잔존 **0** (e2e)
39. 강퇴당해 **다른 클리닉으로 옮긴 사람**의 새 클리닉이 파기될 때, 옛 클리닉에 남은 이력 행이 있어도
    `clinicians` 잔존 **0**이다 (e2e — 두 축 삭제가 없으면 여기서 FK로 실패한다)

fixture 규약: 같은 클리닉 2인은 §35의 `joinByInvitation`으로 만들고 DB 직접 INSERT를 하지 않는다
(§35·§36·§37과 같은 이유 — 그러지 않으면 합류 경로가 검증되지 않은 채 강퇴 기준만 통과한다).
**강퇴 후 재온보딩도 `socialCallback`을 같은 identity로 다시 호출하는 실제 경로를 탄다** — 티켓을
합성하거나 `clinic_id`를 직접 UPDATE해 무소속을 만들지 않는다. 이메일 없는 재로그인(기준 35)은
`SocialIdentity.email = null` + `providerId` **명시**로 만든다(§37 fixture 규약: 미지정 `providerId`는
이메일에서 파생되므로 null 이메일과 함께 쓸 수 없다). 값은 프로덕션에서 복사하지 않고 합성한다.

## Out of scope

- **강퇴 이력 조회 API·강퇴 사유 입력** — 이력은 감사·분쟁 대응이 목적이라 서버에 남기는 것이 먼저다.
  §35 초대 목록과 달리 다음 행동(재발급·취소)이 딸리지 않는다. 사유는 개설자가 쓴 자유 텍스트를
  당사자에게 보일 것인가가 별도 판단이고, 보이지 않는다면 그 텍스트의 존재 자체가 위험이다
- **강퇴 알림**(이메일·인앱) — 발송 인프라 0건이라는 §35 판단 그대로다. 당사자는 다음 로그인에서
  온보딩 화면으로 흘러 알게 된다
- **무소속 계정의 직접 탈퇴** — 세션이 없어 `DELETE /auth/me`에 도달할 수 없다. 재온보딩으로 자기
  클리닉을 만든 뒤 탈퇴하면 마지막 구성원이라 클리닉까지 파기된다(§36 기준 28·29) — 경로가 이미 있다
- **무소속 계정의 자동 파기**(일정 기간 후 tombstone) — 방치분이 실제로 쌓이는지 관측한 뒤 판단한다.
  지금 정하면 표본 0으로 유예 기간을 고르는 셈이다
- **강퇴 철회(undo)** — 다시 초대하면 **같은 계정으로** 복귀한다(기준 36). 되돌리기가 필요하지 않다
- **소속 이동** — 재온보딩은 반드시 클리닉 개설이나 초대를 거친다. §35가 거부한 「초대 없는 직접
  이동」은 그대로 막혀 있다
- **병원 내 역할 세분화** — `ownerClinicianId`가 가르는 것은 초대·이양·강퇴 세 권한뿐이다. 진료 데이터
  접근은 구성원 전원 동등이므로 역할 축이 아직 필요하지 않다(§35 판단 유지)
- FE 강퇴 버튼·확인 UX·재온보딩 화면 문구 — 별도 레포 스펙
