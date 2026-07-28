/**
 * NCKM 수집 설정 (docs/specs/18).
 * 실측 확인된 접속 규약: UA·Referer 누락 시 WAF가 400 `Request Blocked`를 반환하므로
 * User-Agent는 필수이며 기본값을 둔다.
 */
import { baseUrl, nonEmpty, positiveInt } from '../http/env';

const DEFAULT_BASE_URL = 'https://nikom.or.kr';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
/** 요청 간 최소 간격 — 전수 수집 시 770MB를 순차로 받으므로 서버 부하를 낮춘다 */
const DEFAULT_REQUEST_INTERVAL_MS = 500;

export interface NckmConfig {
  baseUrl: string;
  userAgent: string;
  requestIntervalMs: number;
}

export function resolveNckmConfig(env: NodeJS.ProcessEnv): NckmConfig {
  return {
    baseUrl: baseUrl(env.NCKM_BASE_URL, DEFAULT_BASE_URL),
    userAgent: nonEmpty(env.NCKM_USER_AGENT) ?? DEFAULT_USER_AGENT,
    requestIntervalMs: positiveInt(env.NCKM_REQUEST_INTERVAL_MS, DEFAULT_REQUEST_INTERVAL_MS),
  };
}
