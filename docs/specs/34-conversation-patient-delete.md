# 34. 대화·환자 삭제 — 소프트 삭제 + 유예 경과분 파기 크론

> **이 문서는 작성 시점의 작업 지시다 — 현재 시스템 상태가 아니다.** 시스템의 현재 모습은 architecture.md만이 서술한다.
> **1페이지 유지.** architecture.md와 중복 서술 금지 — §링크로만 참조한다.
> 수용 기준은 `/implement` Phase 2에서 테스트로 동결되며, 구현 중 수정할 수 없다.

## 목표

대화와 환자를 **지울 수 있게** 한다. 지금은 보관(ARCHIVED)뿐이라 잘못 만든 항목이 영구히 남는다.
요청은 `deletedAt`을 찍는 데서 끝나고, 유예가 지난 것만 크론이 물리 삭제한다. 삭제 요청 경로와
실제 파기를 분리해, 3~5단 FK 역순 삭제를 요청 트랜잭션 밖으로 밀어낸다.

## 판단 근거 (2026-08-04 사용자 확정)

| 쟁점 | 판단 |
|---|---|
| 의료법 보존 의무 대상인가 | **아니다 — 단, 이것은 이 스펙의 전제이지 결론이 아니다.** 저장물은 진료기록이 아니라 참고안이다(`clinical-guidance.schema.ts:49` «확정 처방이 아닌 검토 대상 참고안», §5.6). 환자도 명부가 아니다 — 성명·주민등록번호·주소·연락처가 스키마·DTO에 **0건**이고, `caseLabel`은 주석이 「비식별 라벨」로 규정하며 §4.5가 `CASE-001` 비식별 식별자를 못박는다. 명부의 법정 기재사항을 갖지 않으므로 명부로 기능할 수 없다. **최종 판단은 법무 영역이므로 유예를 상수가 아니라 설정 파라미터로 둔다** — 판단이 뒤집혀도 값만 바꾸면 된다 |
| 왜 즉시 하드 삭제가 아닌가 | 참조 FK 6개가 **전부 NO ACTION**이다(아래 실측). 즉시 삭제면 요청 하나가 3~5단 역순 트랜잭션으로 최대 수백 행을 지운다. 소프트 삭제는 그 비용을 배치로 옮기고, 오삭제를 DB에서 되돌릴 여지를 남긴다 |
| restore API를 두지 않는 이유 | `deletedAt`은 「복구 유예」가 아니라 **「파기 예약」**이다. 유예는 사용자 기능이 아니라 운영 안전망이므로 사용자 대면 복구 경로가 필요 없다. 대신 모든 조회가 `deletedAt is null` **단일 조건**으로 닫혀, 「삭제됨 목록」 화면도 list 필터 파라미터도 생기지 않는다 |
| 유예는 보존 기간에 더하는가 포함하는가 | **더한다.** 보존 의무는 하한이므로 초과 보관은 위반이 아니지만, 만료 전에 소프트 삭제하면 형식적으로 하한을 깬다. 파라미터화하면 자연히 더하기 구조가 된다 |
| 환자 삭제가 그 환자의 대화까지 끄는가 | **끈다.** 대화를 남기면 퍼지 때 `clinical_guidances.patient_snapshot_id → patients` FK가 살아 있어 `patients` 삭제가 실패한다 — 연쇄하지 않는 선택지는 추가 설계 없이는 성립하지 않는다 |

## 실측 조사 (2026-08-04, 프로덕션 DB)

| 확인 항목 | 실측 |
|---|---|
| 대화 | GUIDELINE_QA 38(전부 ACTIVE) · PATIENT_GUIDANCE 5(ACTIVE 3·ARCHIVED 2) |
| `conversations`·`messages`·`clinical_guidances` 참조 FK 6개의 `confdeltype` | **전부 `a`(NO ACTION)** — cascade 0건 |
| GUIDELINE_QA가 끄는 자식 | messages 84 · citations 21 · runs 7 · feedbacks 0 · **guidances 0** |
| `clinical_guidances` 8건이 붙은 대화 타입 | **PATIENT_GUIDANCE 100%** — 가이던스는 `conversation-stream.service.ts:327`이 이 타입에서만 만든다 |
| PATIENT_GUIDANCE 중 `patient_id` NULL | **0건** — 환자→대화 연쇄가 전건을 덮는다 |
| `guidance.patient_id ≠ conversation.patient_id` | **0건** — 환자 기준 연쇄가 가이던스를 빠짐없이 덮는다 |
| **어떤 가이던스도 참조하지 않는 스냅샷** | **1건** (`01KYWJ00FE6RHQWVF5G7DYK3JB`, 2026-07-31) — 스냅샷이 생성 **직전**에 고정되므로(`:323-327`) 실패·취소된 스트림이 고아를 남긴다 |
| 대화당 최대 | messages 60 · citations 15 · runs 4 |
| 환자당 최대 연쇄 | 대화 2 · 스냅샷 5 · 가이던스 4 |

고아 스냅샷 1건이 **삭제 순서를 결정한다**: 퍼지가 가이던스를 타고 스냅샷에 내려가면 이 행을 놓치고
`patients` 삭제가 FK로 실패한다. 스냅샷은 반드시 **`patient_id` 기준**으로 지운다.

## 범위 (엔드포인트)

| API | Request | Response data | 참조 |
|---|---|---|---|
| DELETE /conversations/{id} | 없음 | null | §5.7 |
| DELETE /patients/{id} | 없음 | null | §5.5 |

상태 코드는 **200 + null 봉투**다 — archive/unarchive 선례(`conversation.controller.ts:79-97`)와 같고,
204는 본문이 없어 §10.1 봉투 규약과 어긋난다. 둘 다 **멱등**이다.

| 진입점 | 변경 |
|---|---|
| `conversation.controller.ts` · `patient.controller.ts` | `@Delete(':id')` 추가. CSRF 커스텀 헤더는 §4.1이 이미 DELETE에 요구한다 |
| `conversation.service.ts` · `patient.service.ts` | 소프트 삭제. **이미 `deletedAt`이 있으면 값을 덮지 않는다** — 재시도마다 갱신하면 파기가 무한히 미뤄진다 |
| `patient.service.ts` 삭제 경로 | 같은 tx에서 그 환자의 `conversations.deleted_at`도 찍는다. **이미 삭제된 대화는 기존 값 유지** — 먼저 삭제된 것이 먼저 파기된다 |
| `conversation.repository.ts` | `findById`·`list`·`findMessageInScope`에 `deleted_at is null` |
| `patient.repository.ts` | `findById`·`list`에 `deleted_at is null` |
| `clinical-guidance.repository.ts` | `findById`에 「살아 있는 대화에 속함」 EXISTS 조인. `findIdsByMessageIds`는 대화 관문을 이미 통과한 메시지만 받으므로 불변 |
| `infrastructure/scheduler/data-purge.cron.ts` (신규) | `guideline-revision.cron.ts` 형태 그대로 — `SchedulerRegistry` **동적 등록**(꺼져 있으면 등록되지 않음), 핸들러는 예외를 밖으로 던지지 않는다 |
| `global/config/data-purge.config.ts` (신규) | `DATA_PURGE_ENABLED`(기본 **false** — §26 선례: 켜짐이 기본이면 로컬·CI가 시간에 의존한다) · `DATA_PURGE_CRON`(기본 `0 18 * * *` = 03:00 KST. 개정 스캔 19시 UTC와 겹치지 않게) · `DATA_PURGE_RETENTION_DAYS`(기본 **30**) · `DATA_PURGE_LOCK_TTL_MS` · `DATA_PURGE_BATCH_SIZE`(기본 200) |
| `domain/.../data-purge.service.ts` (신규) | 판정·삭제 전부. 크론은 호출만 한다 — §26이 e2e를 시간 의존에서 떼어낸 분리를 계승한다. **유예 컷오프는 앱 계층에서 계산해 리포지토리에 넘긴다** — SQL의 `now()`로 계산하면 기준 14의 시각 주입이 성립하지 않는다(코드베이스에 Clock 추상화가 없고, `jest.useFakeTimers()`가 제어하는 것은 `Date.now()`뿐이다) |
| `metrics.service.ts` | `data_purge_total{target=conversation\|patient, outcome=purged\|failed}` + duration 히스토그램 |
| `docs/architecture.md` | §5.5·§5.7 표에 DELETE 행 추가. **§9의 「다음 참조 체인은 반드시 보존한다」 서술 개정** — 사용자 삭제 요청은 이 체인을 파기하는 예외임을 명시 |

**Redis 락은 fail-closed다** — `redis-lock.ts`를 그대로 쓰고 §26의 판단을 계승한다: 못 얻으면 그 틱을
거른다. 크론에서 fail-open은 「락 없이 실행」이고 그것은 락을 두지 않은 것과 같다. 락은 **대상 산출
구간만** 감싼다.

**퍼지 삭제 순서** (FK 역순, 한 tx):

```
대화: guidance_reviews → clinical_guidances → message_citations → generation_runs
      → answer_feedbacks → messages → conversations
환자: patient_profile_snapshots (patient_id 기준 — 고아 포함) → patients
```

환자의 `deletedAt`은 그 환자 대화의 `deletedAt`보다 항상 같거나 늦으므로, 대화가 먼저 또는 동시에
퍼지된다 — 환자 차례에 가이던스는 이미 없다.

## Entity / 마이그레이션 변경분

- `conversations.deleted_at` timestamptz NULL · `patients.deleted_at` timestamptz NULL (마이그레이션 **0017**)
- 부분 인덱스 `idx_conversations_purge`·`idx_patients_purge` on `(deleted_at) where deleted_at is not null`
  — 퍼지 스캔은 삭제된 소수만 훑는다
- **자식 테이블에는 두지 않는다.** 자식은 뿌리를 통해서만 도달하므로 표시는 뿌리 둘로 족하고,
  조회 필터도 그만큼만 는다

## 추가 에러코드

없음 — 삭제가 멱등이고 거부 분기가 없다. 스코프 밖 대상은 기존 `NOT_FOUND`로 충분하다.

## 수용 기준 (= 동결할 시나리오, Definition of Done)

1. `DELETE /conversations/{id}` → 200이고 DB `conversations.deleted_at`이 채워진다 (e2e)
2. 삭제된 대화가 `GET /conversations` 목록에 없다 (e2e)
3. 삭제된 대화의 `GET /conversations/{id}` → 404 (e2e)
4. 삭제된 대화의 `GET /conversations/{id}/messages` → 404 (e2e)
5. 삭제된 대화에 `POST /conversations/{id}/messages/stream` → 404 (e2e)
6. 이미 삭제된 대화를 다시 `DELETE` → 200이고 **`deleted_at` 값이 변하지 않는다** (e2e — 재시도가 파기를 미루지 않는다)
7. 다른 의료인의 대화를 `DELETE` → 404 (e2e — §4.4 스코프)
8. `DELETE /patients/{id}` → 200이고 DB `patients.deleted_at`이 채워진다 (e2e)
9. 환자 삭제가 그 환자의 대화에도 `deleted_at`을 찍는다 (e2e)
10. 환자 삭제 시 **이미 삭제돼 있던 대화의 `deleted_at`은 유지된다** (e2e)
11. 삭제된 환자가 `GET /patients` 목록에 없다 (e2e)
12. 삭제된 환자의 `GET /patients/{id}` → 404 (e2e)
13. 삭제된 대화에 딸린 가이던스의 `GET /clinical-guidance/{guidanceId}` → 404 (e2e)
14. 퍼지가 **유예 경과분만** 물리 삭제한다 — 미경과 대상은 남는다 (유닛 — 주입 시각)
15. 대화 퍼지 후 그 대화의 messages·message_citations·generation_runs·answer_feedbacks 잔존 **0** (e2e)
16. 대화 퍼지 후 그 대화의 clinical_guidances·guidance_reviews 잔존 **0** (e2e)
17. 환자 퍼지가 **어떤 가이던스도 참조하지 않는 스냅샷까지** 지운다 (e2e — 고아 스냅샷 fixture. 이걸 남기면 `patients` 삭제가 FK로 실패한다)
18. 삭제되지 않은 대화·환자는 퍼지가 건드리지 않는다 (e2e)
19. `DATA_PURGE_ENABLED=false`면 `SchedulerRegistry`에 잡이 **등록되지 않는다** (유닛 — §26 기준 31과 같은 이유: 데코레이터는 정적이라 early return과 구분되지 않는다)
20. 락 획득 실패면 그 틱은 **대상 산출조차 하지 않는다** (유닛 — fail-closed)
21. 배치 상한을 넘는 대상은 다음 틱으로 남고, 남긴 수를 로그로 남긴다 (유닛)
22. 퍼지 중 예외가 크론 핸들러 밖으로 나가지 않는다 (유닛)
23. **ARCHIVED 상태의 대화·환자도 삭제된다** — 409가 아니라 200이고 `deleted_at`이 채워진다 (e2e —
    보관과 삭제는 직교한다. `PATIENT_ARCHIVED` 분기가 삭제 경로에 붙지 않았음을 단언한다)

fixture 규약: 고아 스냅샷은 프로덕션 행을 복사하지 않고 **구조를 모방해 합성한다** — 스냅샷을
insert하고 가이던스를 만들지 않으면 실패한 스트림과 같은 형태가 된다.

## Out of scope

- **restore API** — `deletedAt`은 파기 예약이다(위 판단 근거). 필요해지면 별도 스펙
- **법정 보존 기간 자동 파기** — 이 스펙은 **사용자 요청 삭제**만 다룬다. 기간 만료 파기는 기산점이
  필요한데 `patients`에 진료 종료·최종 진료일에 해당하는 필드가 없고, `updatedAt`으로 대신할 수 없다
  (`conversation.schema.ts:52-55`가 `lastMessageAt`을 분리한 것과 같은 이유 — 무관한 UPDATE가 값을
  끌어올린다). 기산점 컬럼 신설부터가 별도 스텝이다
- **삭제 감사 로그** — 누가 언제 무엇을 지웠는지의 별도 테이블. 지금은 `deletedAt`만 남는다
- 클리닉·의료인 계정 삭제, 지침 계열 삭제
- ARCHIVED와의 관계 변경 — 보관은 그대로 유지되며 삭제와 직교한다(보관된 항목도 삭제된다)
- FE 삭제 확인 UX·낙관적 목록 갱신 — 별도 레포 스펙
