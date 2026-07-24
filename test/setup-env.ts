// e2e 부팅용 테스트 환경변수 — 실키가 아니며 테스트 안에서만 사용된다.
process.env.CRYPTO_ENC_KEYS = JSON.stringify({
  v1: Buffer.alloc(32, 1).toString('base64'),
});
process.env.CRYPTO_ENC_ACTIVE_VERSION = 'v1';
process.env.CRYPTO_HMAC_INDEX_KEY = Buffer.alloc(32, 3).toString('base64');
process.env.ALERT_WEBHOOK_URL = '';
// 실 LLM 프로바이더는 e2e에서 등록되면 안 된다 (docs/specs/13 등록 정책) —
// 개발 머신 셸의 실키가 새어들어와 테스트가 외부 API를 때리는 것을 차단한다.
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
// DB·Redis가 필요한 스펙(auth.e2e)은 Testcontainers 기동 후 실제 URL로 덮어쓴다.
process.env.DATABASE_URL = 'postgres://placeholder:placeholder@localhost:5/placeholder';
process.env.REDIS_URL = 'redis://localhost:6390';
process.env.AUTH_JWT_SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.AUTH_ACCESS_TTL_SEC = '900';
process.env.AUTH_REFRESH_TTL_DAYS = '14';
process.env.COOKIE_SECURE = 'false';
process.env.COOKIE_DOMAIN = '';
