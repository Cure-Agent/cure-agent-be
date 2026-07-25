# 15. 알림 채널 다중화 + 중복 억제

> §14의 "5xx·LLM 실패·circuit open·refresh 재사용 → Discord/Slack webhook 즉시 알림"을 실제로 성립시킨다.
> API 계약(OpenAPI) 무변경 — FE 파장 0.

## 목표

알림을 **여러 채널에 동시에**, **채널이 이해하는 형식으로** 보내고, 장애 시 **같은 알림이 폭주하지 않게** 한다.

현재 결함 두 가지:

1. 페이로드가 `{content}` 고정 = Discord 전용. Slack 웹훅에 넣으면 `invalid_payload`로 **조용히 실패**한다(fire-and-forget이라 아무도 모른다). §14는 두 채널을 모두 약속한다.
2. 중복 억제가 `TokenDenylistService`(Redis 장애)에만 있다. 5xx·`LLM_EXHAUSTED`·`LLM_CIRCUIT_OPEN`은 장애가 지속되면 **요청마다 알림**이 나가 채널이 마비된다.

## 범위

| 대상 | 변경 |
|---|---|
| API 엔드포인트 | **없음** |
| `global/observability/` | 신규 `alert-targets.ts`(env → URL 목록), `RealTimeAlertSender` 다중 발송·형식 분기·중복 억제 |
| `global/config/alert.config.ts` | `webhookUrls: string[]` 추가(기존 `webhookUrl`은 입력 경로로만 유지) |
| env | `ALERT_WEBHOOK_URLS`(콤마 구분) 신설. 기존 `ALERT_WEBHOOK_URL`은 계속 동작(하위호환) |

- `AlertEvent`(title/detail/traceId) 형태와 호출부 4곳(5xx·refresh 재사용·Redis 장애·LLM)은 **건드리지 않는다**.
- 전송은 계속 fire-and-forget이다 — 알림 실패가 요청 처리에 영향을 주면 안 된다.

## 채널 판별 (URL 호스트 기준)

| 호스트 | 본문 |
|---|---|
| `hooks.slack.com` | `{ "text": <메시지> }` |
| `discord.com` · `discordapp.com` | `{ "content": <메시지> }` |
| 그 외 | `{ "title", "detail", "traceId", "text" }` — 자체 수집기가 파싱할 수 있는 구조화 JSON |

메시지 본문(text/content)은 현행 포맷을 유지한다: `🚨 **<title>**` + `> <detail>` + `` > traceId: `<traceId>` ``.

## 중복 억제

같은 `title`+`detail` 조합은 **5분 내 1회만** 전송한다(in-memory, 단일 인스턴스 — Redis 공유는 P1).
창이 지나면 다시 전송한다. 억제된 알림은 debug 로그로만 남긴다.

## 수용 기준 (= 동결 유닛 시나리오)

1. `webhookUrls`에 2개(Discord·Slack) → **두 URL 모두**에 POST(각 1회), 각각 URL이 정확히 일치
2. **형식 분기**: slack URL 본문은 `{text}`(content 키 없음) / discord URL 본문은 `{content}`(text 키 없음) /
   그 외 호스트는 `title`·`detail`·`traceId`·`text` 키를 가진 JSON
3. **메시지 내용**: 전송 본문 텍스트에 `title`, `detail`, `traceId`가 모두 포함된다
4. **중복 억제**: 같은 `{title, detail}`로 3회 연속 `send` → fetch 총 호출은 채널당 1회.
   `Date.now()`가 5분을 넘긴 뒤 다시 `send` → 채널당 1회 추가 전송
5. **부분 실패 격리**: 첫 채널의 fetch가 reject해도 두 번째 채널로는 전송되고, `send()`는 예외를 던지지 않는다
6. **대상 0개**: `webhookUrls`가 빈 배열이면 fetch를 호출하지 않는다
7. **`resolveAlertTargets(env)`**: `ALERT_WEBHOOK_URL`만 → `[그 URL]` / `ALERT_WEBHOOK_URLS='a, b'` → `['a','b']`(공백 트림) /
   둘 다 있고 겹치면 **중복 제거** / 둘 다 없으면 `[]`

## 테스트 전략

전부 유닛(fetch 목)으로 동결한다 — 외부 웹훅은 CI에서 호출할 수 없고, DB도 필요 없다.
기존 e2e(알림이 켜지지 않은 상태에서 동작해야 함)는 전체 회귀로 확인한다. Codex 교차 작성 유지.

## Out of scope

- severity 등급·채널별 라우팅(호출부 전면 수정 필요), 재시도·큐잉, Redis 공유 억제 상태(멀티 인스턴스), PagerDuty 등 비-webhook 채널
- Prometheus `/metrics` 노출(§14에서 P1로 명시)
