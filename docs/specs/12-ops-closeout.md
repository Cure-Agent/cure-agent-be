# 12. 운영 마감 (§15-12)

> BE + FE 양 레포. **동결 e2e 없음** — 이 스텝은 OpenAPI 계약 무변경(FE codegen 파장 0)이고,
> 신규 동작은 외부 webhook 알림뿐이라 e2e 동결 대상 계약이 없다. 검증은 ①유닛(알림 트리거)
> ②기존 동결 스위트 전체 회귀 ③CI 점검표로 대체한다. (Codex 교차 작성은 동결 계약 부재로 생략)

## 범위 (BE)

1. **실시간 장애 알림 연결 완결 (§14)** — 기연결: 5xx(ApiExceptionFilter, ignorable 분류 제외),
   refresh 재사용(AuthService — auth e2e 동결 검증), Redis 장애(TokenDenylistService, 5분 dedupe).
   **잔여 연결(본 스텝): LlmGateway** —
   - 전 프로바이더 소진(LlmExhaustedError 직전) → `LLM_EXHAUSTED` 알림 (개별 프로바이더 실패는 warn 로그 유지 — §14의 'LLM 실패'는 사용자 영향이 생기는 소진으로 해석, 알림 노이즈 방지)
   - recordFailure로 서킷 **open 전이 시** → `LLM_CIRCUIT_OPEN` 알림 (전이 1회만)
2. **로컬 운영 편의**: `docker-compose.yml`(pgvector:pg17 + redis:7-alpine, healthcheck) + `.env.example`(env.validation 필수 키) + `README.md`(스택·구동·테스트·계약 파이프라인)

## 범위 (FE)

- `README.md` (스택·구동·codegen·테스트) — 코드 무변경

## 수용 기준

1. 유닛(llm-gateway.spec): 전 프로바이더 실패 → sender.send가 `LLM_EXHAUSTED`로 호출되고 LlmExhaustedError 전파
2. 유닛: 연속 실패 5회로 open 전이 시 `LLM_CIRCUIT_OPEN` 1회 알림(4회까지는 미호출), abort 시 알림 없음
3. 기존 동결 스위트 전체 회귀 GREEN (e2e 63 + 유닛) — 크로스테넌트(guideline 8·patient 5·clinical-guidance 8·history 5·conversation 스코프)와 SSE 복구(conversation 기준 11 CANCELLED·§8 GET messages 폴백)는 기존 동결이 이미 커버함을 점검표로 확인
4. CI 점검표: BE(build-test·openapi-breaking·gitleaks)·FE(codegen-check·gitleaks)·contract-notify→Contract Sync 전 구간 green (10·11단계 실운영으로 검증됨)

## Out of scope

- 실 LLM 프로바이더 연동(**spec 13**), 알림 채널 다중화·페이징 정책, 운영 배포 인프라(k8s 등)
