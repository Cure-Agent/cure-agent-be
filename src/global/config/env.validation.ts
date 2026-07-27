/**
 * 부팅 시 필수 환경변수를 fail-fast로 검증한다.
 * 새 필수 env를 추가하면 .env.example도 같은 PR에서 갱신한다.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const problems: string[] = [];

  const encKeysRaw = config.CRYPTO_ENC_KEYS;
  if (typeof encKeysRaw !== 'string' || encKeysRaw.length === 0) {
    problems.push('CRYPTO_ENC_KEYS가 필요합니다. 형식: {"v1":"<base64 32바이트>"}');
  } else {
    try {
      const parsed = JSON.parse(encKeysRaw) as Record<string, string>;
      const versions = Object.keys(parsed);
      if (versions.length === 0) problems.push('CRYPTO_ENC_KEYS에 키가 하나 이상 필요합니다.');
      for (const [version, b64] of Object.entries(parsed)) {
        if (Buffer.from(b64, 'base64').length !== 32) {
          problems.push(`CRYPTO_ENC_KEYS[${version}]는 base64 32바이트 키여야 합니다.`);
        }
      }
      const active = config.CRYPTO_ENC_ACTIVE_VERSION;
      if (typeof active !== 'string' || !versions.includes(active)) {
        problems.push('CRYPTO_ENC_ACTIVE_VERSION이 CRYPTO_ENC_KEYS의 버전 중 하나여야 합니다.');
      }
    } catch {
      problems.push('CRYPTO_ENC_KEYS가 올바른 JSON이 아닙니다.');
    }
  }

  const hmacKey = config.CRYPTO_HMAC_INDEX_KEY;
  if (typeof hmacKey !== 'string' || Buffer.from(hmacKey, 'base64').length < 32) {
    problems.push('CRYPTO_HMAC_INDEX_KEY는 base64 32바이트 이상이어야 합니다.');
  }

  const databaseUrl = config.DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    problems.push('DATABASE_URL이 필요합니다. 예: postgres://user:pass@localhost:5432/cure_agent');
  }

  const jwtSecret = config.AUTH_JWT_SECRET;
  if (typeof jwtSecret !== 'string' || jwtSecret.length < 32) {
    problems.push('AUTH_JWT_SECRET은 32자 이상이어야 합니다. 생성: openssl rand -base64 48');
  }

  const redisUrl = config.REDIS_URL;
  if (typeof redisUrl !== 'string' || redisUrl.length === 0) {
    problems.push('REDIS_URL이 필요합니다. 예: redis://localhost:6379');
  }

  // 소셜 로그인 (docs/specs/17). client id는 제공자별 선택이지만,
  // 하나도 없으면 로그인 수단이 전무하므로 부팅을 막는다.
  const hasAnyOAuthProvider = ['GOOGLE_CLIENT_ID', 'KAKAO_CLIENT_ID', 'NAVER_CLIENT_ID'].some(
    (key) => typeof config[key] === 'string' && (config[key] as string).length > 0,
  );
  if (!hasAnyOAuthProvider) {
    problems.push(
      'GOOGLE_CLIENT_ID / KAKAO_CLIENT_ID / NAVER_CLIENT_ID 중 최소 하나가 필요합니다. ' +
        '소셜 로그인이 유일한 인증 수단입니다.',
    );
  }

  const webBaseUrl = config.OAUTH_WEB_BASE_URL;
  if (typeof webBaseUrl !== 'string' || !/^https?:\/\//.test(webBaseUrl)) {
    problems.push(
      'OAUTH_WEB_BASE_URL은 http(s) 절대 URL이어야 합니다. ' +
        'OAuth 콜백을 받는 프론트엔드 오리진 (로컬: http://localhost:3001)',
    );
  }

  if (problems.length > 0) {
    throw new Error(`환경변수 검증 실패:\n- ${problems.join('\n- ')}`);
  }
  return config;
}
