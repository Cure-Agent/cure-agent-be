# 35. 클리닉 초대·합류 + 대화 공유 전환

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 테스트로 동결되며, 구현 중 수정할 수 없다.

## 목표

한 한의원에 **구성원이 둘 이상 존재할 수 있게** 한다. 지금은 clinic 생성 경로가 회원가입 한 곳뿐이라
(`auth.service.ts:97`) clinic:clinician이 구조적으로 1:1이다. 개설자가 초대 링크를 발급해 직접 전달하고,
받은 사람은 그 링크로 가입하면서 기존 클리닉에 합류한다. 동시에 대화 조회 스코프를 §4.4가 이미 규정한
**clinic 스코프로 정렬해**, 합류한 구성원이 환자·대화·가이던스를 함께 본다.

## 판단 근거 (2026-08-04 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 왜 대화 공유가 초대와 **같은 스펙**인가 | §4.4는 「patient / conversation / clinical-guidance / feedback의 모든 조회·변경은 요청자의 clinic 스코프로 필터링한다」이고 시그니처 예시도 `ClinicScope`다. 그런데 실제로 clinic 스코프인 것은 patient·guidance뿐이고 **conversation만 `clinicianId`**다(`conversation.repository.ts:37`). 1:1이라 두 스코프가 실질적으로 같아 드러나지 않았을 뿐이다. 구성원이 2명이 되는 순간 **가이던스는 보이는데 그 가이던스가 달린 대화는 404**가 되는 모순이 실재한다 — `clinical-guidance.repository.ts:30`의 `findById`는 `clinicId`로 열고 대화는 삭제 여부만 볼 뿐 소유자를 보지 않는다. 초대만 넣고 공유를 미루면 이 모순이 프로덕션에 뜬다 |
| 초대 전달 수단 | **링크를 개설자가 직접 전달한다.** 이메일 발송 인프라가 **0건**이다(실측) — 초대 메일 하나를 위해 발송 도메인·반송 처리·템플릿이 따라온다. 링크 전달은 인프라 없이 성립한다 |
| 병원 권한을 `clinicians.role`로 재활용? | **불가.** ADMIN/MEMBER는 **플랫폼 관리 권한**이다 — `admin.guard.ts:28`이 지침 관리 API(§21) 게이트로 쓰고, 스키마 주석도 「최초 ADMIN 지정은 수동 UPDATE」로 못박는다. 여기에 병원 내 권한을 얹으면 한 컬럼이 두 가지를 뜻한다. **`clinics.ownerClinicianId` 신설**로 분리한다 |
| 동료 대화의 쓰기 범위 | **전원 동등 — 이어질문·이름변경·보관·삭제 전부.** 읽기만 공유하고 변경을 소유자로 남기면 리포지토리에 두 스코프가 공존해 §4.4의 「서비스 코드의 선의에 맡기지 않는다」가 흐려진다. 오삭제 위험은 §34 소프트 삭제(유예 기본 30일, 파기 예약)가 흡수한다 |
| 기소속 계정의 초대 수락 | **거부한다.** `clinicians.clinic_id`가 notNull이라 소속 이동은 「기존 클리닉에 남긴 대화·환자의 접근권을 어떻게 하는가」가 따라붙는 별도 문제다. 프로덕션에 1인 클리닉이 3개라 실재하는 경로이므로 무정의로 두지 않고 명시적으로 막는다 |
| 초대 링크 수명 | **1회용 + 만료**(`CLINIC_INVITATION_TTL_DAYS`, 기본 7). 링크가 메신저로 전달되므로 유출 창을 좁힌다 — §4.2 신규 가입 티켓의 1회성(GETDEL) 관행과 같은 이유 |
| 저장소를 테이블로 | 개설자가 **보낸 초대 목록·취소·수락 이력**을 봐야 한다. Redis TTL은 소멸형이라 「누가 언제 합류했는가」가 남지 않는다 — §4.3이 refresh 원본 저장소로 Redis를 쓰지 않은 것과 같은 이유(이력이 요구되면 TTL 소멸형은 원본이 될 수 없다) |
| 토큰을 해시로만 저장 | 원문을 저장하면 DB 유출이 곧 합류 권한 유출이다. §4.3 refresh 관행 계승 — 쿠키는 `sessionId.secret`, DB에는 sha256만. 초대도 `invitationId.secret` 형태라 조회가 id로 O(1)이다. **부작용: 발급 응답이 토큰을 보여줄 유일한 기회다** — 분실 시 재발급뿐이며 목록 API는 토큰을 실을 수 없다 |

## 실측 조사 (2026-08-04, 프로덕션 DB + 코드)

| 확인 항목 | 실측 |
|---|---|
| clinic : clinician | **3 : 3 — 전부 1:1** (clinic당 clinician 1명, 예외 0) |
| clinic 생성 경로 | `auth.service.ts:97` **한 곳**. 초대·합류 API **0건** |
| 이메일 발송 인프라 | **0건** — nodemailer·SendGrid·SES·SMTP 전부 |
| 스코프 실태 | `PatientScope{clinicId}` · `GuidanceScope{clinicId}` · **`ConversationScope{clinicianId}`** · `ClinicScope{clinicianId, clinicId}`(principal) |
| `conversations.clinic_id` | **이미 존재**(notNull, `:41`). 소유 clinician의 `clinic_id`와 **불일치 0건** → 데이터 백필 불필요 |
| `conversations` 인덱스 | `idx_conversations_clinician`·`idx_conversations_clinician_last_message` — 둘 다 **clinician_id 선두**. clinic 기준 목록은 이 keyset을 타지 못한다 |
| `clinicians` 참조 FK | **5개 전부 NO ACTION**(`a`) — auth_sessions · conversations · answer_feedbacks · guidance_reviews · guideline_jobs.requested_by |
| `clinicians` unique | `uq_clinicians_email(email)` · `uq_clinicians_oauth(provider, providerId)` |
| 클리닉별 자산 | A: 환자 5 · 대화 42 · 가이던스 8 / B: 전부 0 / C: 대화 1 |
| **같은 클리닉 동료 격리를 동결한 e2e** | **0건.** `socialSignUp`이 매번 새 `clinicName`으로 클리닉을 만들므로(`test/fixtures/social-auth.ts:123`) 기존 격리 테스트(§34 기준 7, `history.e2e-spec.ts:407`)는 **전부 타 클리닉**이다 |

마지막 행이 이 스펙의 안전 마진이다: **공유 전환은 기존 동결을 하나도 깨지 않는다.** 타 클리닉 404는
그대로 유지되고, 새로 생기는 것은 「같은 클리닉 동료 → 200」이라는 **추가** 단언뿐이다.

## 범위 (엔드포인트)

| API | Request | Response data | 참조 |
|---|---|---|---|
| POST /clinic/invitations | 없음 | ClinicInvitationIssuedResponseDto (**token 포함 — 유일 노출**) | §5.8 |
| GET /clinic/invitations | ListClinicInvitationsQueryDto | ClinicInvitationResponseDto[] + page | §5.8 |
| DELETE /clinic/invitations/{id} | 없음 | null | §5.8 |
| GET /invitations/{token} | 없음 (**비인증**) | ClinicInvitationPreviewResponseDto (`clinicName`만) | §5.2 |
| POST /auth/signup (확장) | CompleteSignUpRequestDto + `invitationToken?` | AuthSessionResponseDto (+Set-Cookie) | §4.2 |

프리뷰만 인증 밖에 둔다 — 초대받은 사람은 아직 계정이 없다. 인증 리소스(`/clinic/...`)와 경로를 분리해
가드 적용 범위가 한눈에 갈리게 한다. `status`(`PENDING`·`ACCEPTED`·`REVOKED`·`EXPIRED`)는 컬럼이 아니라
`acceptedAt`·`revokedAt`·`expiresAt`에서 **파생**한다 — 만료를 컬럼으로 두면 갱신 주체가 필요해진다.

| 진입점 | 변경 |
|---|---|
| `clinic-invitation.controller.ts`·`service`·`repository` (신규) | 발급·목록·취소. 발급/목록/취소는 **개설자 전용**(`clinics.ownerClinicianId` 대조) — `admin.guard`는 플랫폼 권한이라 재사용하지 않는다 |
| `auth.service.ts` `completeSignUp` | `invitationToken`이 있으면 **clinic을 만들지 않고** 초대의 `clinicId`로 clinician을 만든다. 같은 tx에서 초대를 소비(`acceptedAt`·`acceptedByClinicianId`). 기존 `existsByEmail` 검사는 **초대 소비보다 앞선다** — 기준 17 |
| `CompleteSignUpRequestDto` | `invitationToken?` 추가. **`invitationToken`과 `clinicName`을 함께 보내면 422** — 조용히 무시하면 사용자가 입력한 한의원명이 어디로 갔는지 알 수 없고, 서버가 모순된 요청을 임의 해석하는 셈이 된다 |
| `conversation.repository.ts` | `ConversationScope{clinicianId}` → **`{clinicId}`**. `findById`·`list`·`findMessageInScope` 등 스코프 조건 전부 `conversations.clinicId` 기준으로. `insertConversation`은 작성자 기록을 위해 `clinicianId`를 **계속 쓴다**(§36 탈퇴 처분의 근거이자 감사 흔적) |
| `conversation.service.ts` | principal의 `clinicId`로 스코프 구성 (`ClinicScope`가 이미 둘 다 갖는다) |
| `feedback` 경로 | 피드백 작성자는 계속 `clinicianId`다 — `uq_answer_feedbacks_message_clinician`이 구성원별 1건을 보장하므로 동료가 같은 메시지에 각자 남긴다 |
| `clinician.repository.ts` | `insertClinic`에 owner 지정 UPDATE 동반. `findRoleById`는 불변 |
| `metrics.service.ts` | `clinic_invitation_total{outcome=issued\|accepted\|rejected\|revoked}` |
| `docs/architecture.md` | §5.2에 초대 프리뷰·합류 경로, §5.8(신설) 초대 관리, §9에 `ClinicEntity.ownerClinicianId`·`ClinicInvitationEntity` 추가. **§5.7에 「대화는 작성자 개인 소유가 아니라 클리닉 공유」 명시.** §4.4는 **개정하지 않는다** — 이 스펙이 문서를 바꾸는 게 아니라 코드를 문서에 맞춘다 |

## Entity / 마이그레이션 변경분 (마이그레이션 **0018**)

- `clinics.owner_clinician_id` text **NULL** references `clinicians(id)`.
  **NULL 허용이 필수다** — `clinicians.clinic_id → clinics.id`와 순환 참조라, notNull이면 clinic을
  먼저 insert할 수 없다. 생성 순서는 clinic(owner NULL) → clinician → clinic UPDATE owner.
  기존 3개 클리닉은 **유일 구성원으로 백필**한다(1:1이라 모호성 0 — 위 실측)
- `clinic_invitations` (신규): `id` · `clinic_id` → clinics · `invited_by_clinician_id` → clinicians ·
  `token_hash` text notNull · `expires_at` timestamptz notNull · `accepted_at` · `accepted_by_clinician_id` ·
  `revoked_at` · baseColumns. 인덱스 `idx_clinic_invitations_clinic (clinic_id, created_at desc)`
- `idx_conversations_clinician_last_message` **→ `idx_conversations_clinic_last_message (clinic_id, last_message_at, id)`로 교체.**
  목록이 clinic 기준으로 바뀌면 기존 복합 인덱스는 keyset 스캔에 쓰이지 않는다(`conversation.repository.ts:93` 주석이
  가리키는 그 인덱스다). 단일 `idx_conversations_clinician`은 **남긴다** — 작성자 기준 조회가 §36에서 필요하다
- `conversations.clinic_id`에 **데이터 마이그레이션은 없다** — 불일치 0건 실측

## 추가 에러코드

- `INVITATION_INVALID` (404) — 「유효하지 않거나 만료된 초대 링크입니다. 개설자에게 새 링크를 요청해주세요.」
  **만료·사용됨·취소됨·존재하지 않음을 하나로 뭉친다.** 상태를 구분해 알려주면 유출된 토큰에 대해
  「이건 실재하는 초대였다」를 확인해주는 셈이다 — §4.4의 「존재 여부 자체를 숨김」과 같은 이유.
  문구가 다음 행동(재요청)을 담으므로 UX 손실은 없다
- 개설자 아닌 구성원의 초대 조작은 기존 `FORBIDDEN`으로 충분하다
- 기소속 계정의 수락은 기존 `AUTH_EMAIL_ALREADY_USED`(409)가 이미 덮는다 — 신설하지 않는다

## 수용 기준 (= 동결할 시나리오, Definition of Done)

**초대 발급**

1. 개설자의 `POST /clinic/invitations` → 201이고 응답 data에 `token`이 있다 (e2e)
2. 발급된 `token` 원문이 **DB 어느 컬럼에도 저장되지 않는다** — `clinic_invitations.token_hash`만 채워진다 (e2e)
3. 개설자가 **아닌** 구성원의 `POST /clinic/invitations` → **403** (e2e)
4. `expiresAt` = 발급 시각 + `CLINIC_INVITATION_TTL_DAYS` (유닛 — 주입 시각. §34 기준 14와 같은 이유: 컷오프를 SQL `now()`로 계산하면 시각 주입이 성립하지 않는다)

**목록·취소**

5. `GET /clinic/invitations`는 자기 클리닉 초대만 반환한다 — 타 클리닉 초대는 목록에 없다 (e2e)
6. 목록 응답 어느 항목에도 `token` 필드가 **없다** (e2e — 해시만 저장하므로 실을 수 없다)
7. 개설자가 아닌 구성원의 `GET /clinic/invitations` → 403 (e2e)
8. 타 클리닉 초대의 `DELETE /clinic/invitations/{id}` → **404**이고 그 행의 `revoked_at`이 **변하지 않는다** (e2e — §4.4 스코프. 양성 대조군 포함)
9. 취소된 초대의 토큰으로 프리뷰 → 404 `INVITATION_INVALID` (e2e)

**프리뷰**

10. 비인증 `GET /invitations/{token}` → 200이고 `clinicName`을 반환한다 (e2e)
11. 프리뷰 응답에 `clinicId`·초대자 식별정보·`invitationId`가 **없다** (e2e — 링크만 가진 외부인에게 주는 정보를 한의원명으로 한정)

**합류**

12. 초대 토큰으로 signup → 201이고 **`clinics` 총 건수가 늘지 않는다** (e2e — 새 클리닉이 만들어지지 않았음의 직접 단언)
13. 합류자의 `clinicId`가 **초대한 개설자의 `clinicId`와 같다** (e2e)
14. `invitationToken`과 `clinicName`을 함께 보내면 **422** (e2e)
15. 합류 성공 시 `accepted_at`·`accepted_by_clinician_id`가 채워진다 (e2e)
16. **같은 토큰 재사용** → 404 `INVITATION_INVALID` (e2e — 1회용)
17. 이미 가입된 이메일이 초대 토큰으로 signup → **409** `AUTH_EMAIL_ALREADY_USED`이고 그 초대의 `accepted_at`은 **null로 남는다** (e2e — 실패가 초대를 소비하지 않는다)
18. 만료된 초대 토큰으로 signup → 404 (유닛 — 주입 시각)
19. 합류자의 `clinicians.role`이 **`MEMBER`**다 (e2e — 초대가 플랫폼 권한을 승격시키지 않는다)
20. 합류 후에도 `clinics.owner_clinician_id`가 **개설자 그대로**다 (e2e)

**공유 (합류자 관점 — 전부 같은 클리닉 동료의 자원)**

21. 동료가 만든 대화가 합류자의 `GET /conversations` 목록에 **보인다** (e2e)
22. 동료 대화의 `GET /conversations/{id}` → 200 (e2e)
23. 동료 대화의 `GET /conversations/{id}/messages` → 200 (e2e)
24. 동료 대화에 `POST /conversations/{id}/messages/stream` → 스트림이 정상 도달한다 (e2e)
25. 동료 대화의 `PATCH /conversations/{id}`(이름 변경) → 200 (e2e)
26. 동료 대화의 `DELETE /conversations/{id}` → 200이고 `deleted_at`이 채워진다 (e2e — 전원 동등)
27. 동료가 등록한 환자의 `GET /patients/{id}` → 200 (e2e — 이미 clinicId 스코프이므로 **회귀 방지**)
28. 동료 대화에 딸린 가이던스의 `GET /clinical-guidance/{id}` → 200 (e2e — 판단 근거의 모순이 해소됐음을 단언)
29. **타 클리닉** 대화의 `GET`·`DELETE` → 여전히 **404** (e2e — §34 기준 7 불변. 공유가 클리닉 경계를 넘지 않는다)
30. 같은 메시지에 두 구성원이 각각 피드백을 남길 수 있다 — 둘 다 201이고 `answer_feedbacks` 2행 (e2e — `uq_answer_feedbacks_message_clinician`은 구성원별 1건이지 메시지별 1건이 아니다)
31. 삭제된 동료 대화는 합류자의 목록·상세에서도 사라진다 (e2e — §34 기준 2·3이 clinic 스코프에서도 성립)

fixture 규약: **같은 클리닉 2인 세션을 만드는 헬퍼가 이 스펙의 산출물이다** — 현재 `socialSignUp`은
매번 새 클리닉을 만들므로(위 실측) 동료를 만들 수단이 없다. `test/fixtures/social-auth.ts`에
`joinByInvitation(app, ownerSession, identity)`를 추가한다: 개설자로 초대를 발급받아 그 토큰으로
signup하는 실제 경로를 그대로 탄다 — DB에 직접 INSERT해 동료를 만들지 않는다(그러면 합류 경로 자체가
검증되지 않은 채 공유 기준만 통과한다). 초대 토큰은 프로덕션 값을 복사하지 않고 합성한다.

## Out of scope

- **회원탈퇴·구성원 제거** — spec 36. 이 스펙이 만든 다중 구성원 전제 위에서만 성립한다.
  `clinicians` 참조 FK 5개(전부 NO ACTION)와 `uq_clinicians_email`이 그 스펙의 쟁점이다
- **소속 이동** — 기소속 계정은 거부한다(위 판단). 이동은 기존 클리닉 자산의 접근권 처분이 선결이다
- **이메일 발송** — 인프라 0건. 링크 전달은 개설자의 몫이다
- **개설자 권한 이양·병원 내 역할 세분화** — 지금 `ownerClinicianId`가 가르는 것은 **초대 권한 하나**다.
  진료 데이터 접근은 구성원 전원 동등이므로 역할 축이 아직 필요하지 않다
- **초대 재발급·링크 재열람** — 토큰 해시만 저장하므로 분실 시 새로 발급한다(발급 API로 충분)
- `clinicians.role`(플랫폼 ADMIN) 관리 API — §21 Out of scope 유지
- **대화 작성자 표시 UI**(누가 만든 대화인지 배지) — `clinicianId`는 계속 기록되나 응답 DTO 확장·FE 렌더는 별도 레포 스펙
