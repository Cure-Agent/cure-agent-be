import { INestApplication } from '@nestjs/common';

/**
 * e2e 앱 부트스트랩 — **init에서 멈추지 않고 listen까지 한다** (issue #250).
 *
 * supertest는 서버가 listen 중이 아니면 **요청마다** 임시 포트로 서버를 열고 응답 후 닫는다:
 *
 * ```js
 * serverAddress(app, path) { if (!app.address()) this._server = app.listen(0); }
 * end(fn) { if (server && server._handle) server.close(...); }
 * ```
 *
 * 계측 실측(2026-08-02): 26개 중 14개 스위트만 돈 실행에서 LISTEN이 355회, 전체로는 약 700회다.
 * 이 개폐가 두 가지 레이스를 만든다.
 *
 * 1. 한 요청이 끝나며 부르는 `server.close()`가, 같은 앱에 접속 중인 다른 요청을 끊는다
 *    → `socket hang up`
 * 2. 방금 닫힌 포트를 **다른 앱**이 받으면 요청이 엉뚱한 앱에 도착한다
 *    → 등록된 라우트가 404, 503을 낼 수 없는 목록 조회가 503, 유효한 티켓이 401
 *
 * 전체 e2e 20회 중 4회가 이 때문에 실패했고(두 번 반복 실측 모두 4/20), 매번 다른 스위트에서
 * 났다. 단독 실행이 늘 통과하던 이유도 같다 — 포트를 주고받을 다른 앱이 없었다.
 *
 * **한 번 listen시켜 두면 supertest의 `this._server`가 undefined가 되어 닫지 않는다.**
 * 포트 사이클이 실행당 ~700회에서 앱 개수만큼으로 떨어진다.
 *
 * 컨테이너 경합·메모리 압박·HTTP keepAlive 풀·포트 충돌은 모두 통제 실험으로 반증됐다.
 */
/**
 * **`127.0.0.1`에 명시적으로 바인드한다 — 이것이 남은 flake의 원인이었다** (issue #250).
 *
 * 인자 없는 `listen(0)`은 `0.0.0.0`(전 인터페이스)에 붙는다. 그런데 커널은 **주소가 다르면
 * 같은 포트의 바인드를 허용한다** — 다른 프로세스가 `127.0.0.1:P`를 이미 잡고 있어도
 * `0.0.0.0:P` 바인드는 성공한다. 개발 머신에는 그런 리스너가 흔하다(실측: JetBrains IDE들이
 * 30000~30003을 127.0.0.1에 점유 중인데 Node의 0.0.0.0 바인드는 통과했다).
 *
 * 그런데 supertest는 `http://127.0.0.1:<port>`로 접속하고, 커널은 **더 구체적인 바인드**를
 * 고른다 → 요청이 **남의 서버**에 도착한다. 실측된 응답이 그 증거다:
 * `status=404 body={} headers={content-length:0, connection:close}` — `Date`도 응답 봉투도
 * 없으니 Node·Nest가 보낸 것이 아니다.
 *
 * `127.0.0.1`로 바인드하면 커널이 그 주소에서 **정말 비어 있는 포트만** 내주므로 이 충돌이
 * 원천 차단된다. 고정 포트 대역은 답이 아니다 — 어느 대역이든 남이 먼저 잡고 있을 수 있다.
 */
export async function bootstrapApp<T extends INestApplication>(app: T): Promise<T> {
  await app.init();
  await app.listen(0, '127.0.0.1');
  return app;
}
