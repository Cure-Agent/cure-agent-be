// e2e 부팅용 테스트 환경변수 — 실키가 아니며 테스트 안에서만 사용된다.
process.env.CRYPTO_ENC_KEYS = JSON.stringify({
  v1: Buffer.alloc(32, 1).toString('base64'),
});
process.env.CRYPTO_ENC_ACTIVE_VERSION = 'v1';
process.env.CRYPTO_HMAC_INDEX_KEY = Buffer.alloc(32, 3).toString('base64');
process.env.ALERT_WEBHOOK_URL = '';
