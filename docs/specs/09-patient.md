# 09. Patient + PatientProfileSnapshot

> BE(cure-agent-be) + FE(cure-agent-fe) 양 레포. 동결 테스트는 레포별 분리 — **Codex 작성 / Claude 리뷰·구현** (§15 교차 작성).

## 목표

환자 프로필 CRUD(§5.5·§5.6)를 clinic 스코프(§4.4)와 민감 필드 암호화(§4.5), 낙관적 잠금으로 구현하고, 10단계(ClinicalGuidance)가 소비할 PatientProfileSnapshot 저장 기반을 만든다. FE 환자 목록·상세 화면까지.

## 범위 (BE)

| API | Request | Response data | 참조 |
|---|---|---|---|
| GET /patients | ListPatientsQueryDto(query·status·cursor·size) | PatientSummaryResponseDto[] + page | §5.5 §6 |
| POST /patients | CreatePatientRequestDto | PatientDetailResponseDto (201) | §5.5 §6 |
| GET /patients/{patientId} | – | PatientDetailResponseDto | §5.6 |
| PATCH /patients/{patientId} | UpdatePatientRequestDto(partial + version) | PatientDetailResponseDto | §5.6 §6 |
| POST /patients/{patientId}/archive · /unarchive | – | null | §5.5 |

- **스코프 = clinicId** (§4.4: 환자는 클리닉 공유 리소스). repository 메서드는 ClinicScope 필수, 타 클리닉은 404.
- **암호화(§4.5)**: `diagnoses`/`medications`/`allergies`(JSON 직렬화 후)·`clinicalNotes`는 AES-GCM 암호문으로만 저장. `caseLabel`은 비식별 라벨이라 평문(ILIKE 검색 대상).
- **낙관적 잠금**: PATCH는 version 필수 — 불일치 시 409 `PATIENT_VERSION_CONFLICT` + `data.currentVersion`(§10.1 실패 예시 그대로). 성공 시 version+1.
- **보관**: ARCHIVED 상태에서 PATCH → 409 `PATIENT_ARCHIVED`. 목록 status 필터.
- Summary 파생 필드: age(birthYear 기준)·bmi(소수 1자리) — Detail은 §6 전체 필드 + version.
- **PatientProfileSnapshot**: `PatientSnapshotService.capture(scope, patientId)` → 환자 전체 프로필을 **암호화 JSON payload**로 immutable 저장, snapshotId 반환. 자동 트리거는 10단계.

## 범위 (FE)

- features/manage-patient: usePatients(query)/useCreatePatient/usePatient/useUpdatePatient/useArchivePatient 훅 + 목록(검색·등록 폼·보관 토글)·상세(수정 폼) — `/patients`, `/patients/[patientId]` 라우트
- 409 PATIENT_VERSION_CONFLICT 수신 시 충돌 안내 렌더 (ApiError.code 분기)

## 추가 에러코드

- 없음 — `PATIENT_VERSION_CONFLICT`·`PATIENT_ARCHIVED` 기등록 (§10.2)

## 수용 기준 — BE e2e (Codex 작성, 각 테스트는 스텁 상태에서 실패해야 함)

1. POST /patients → 201 CREATED, Detail(version=1, bmi·age 파생). **DB 원문 부재**: 민감 필드가 평문으로 저장되지 않고 `v1.` 프리픽스 암호문, 조회 API는 원문 복원
2. GET /patients: Summary 목록 + 커서 페이지네이션(중복 없이 전체 순회)
3. GET /patients?query=: caseLabel 부분일치
4. GET /patients/{id}: 상세 200 → 미존재 id 404
5. 타 클리닉 격리: 소유 계정 200 확인 **선행** 후, 타 클리닉 계정으로 GET/PATCH/archive → 전부 404
6. PATCH: 올바른 version → 반영 + version 증가. 직전(구) version 재사용 → 409 PATIENT_VERSION_CONFLICT + data.currentVersion
7. archive → PATCH 409 PATIENT_ARCHIVED → unarchive → PATCH 성공. status=ARCHIVED 필터에 노출
8. PatientSnapshotService.capture → snapshot 행 생성, payload는 DB에서 암호문이며 복호화 시 환자 프로필과 일치
9. 미인증 접근(목록·생성) → 401

## 수용 기준 — FE vitest (Codex 작성)

10. 환자 목록: MSW → caseLabel 렌더, 검색 제출 → query 파라미터 재조회
11. 등록 폼: 제출 → POST body(caseLabel·배열 필드 포함) 검증 + 성공 콜백
12. 수정 폼: version 포함 PATCH, MSW가 409 PATIENT_VERSION_CONFLICT 반환 시 충돌 안내 렌더
13. 보관 토글: archive/unarchive 호출 검증

## Out of scope

- PATIENT_GUIDANCE 대화 연결·가이던스 생성·스냅샷 자동 캡처 (10단계)
- 환자 삭제(archive로 대체), caseLabel 자동 채번, CSV 가져오기
- FE 스냅샷 UI (10단계)
