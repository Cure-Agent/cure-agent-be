/**
 * retrieval 이후 실패의 원인별 코드 분류 (§8 error 이벤트).
 * 회귀: 예전엔 전부 LLM_UNAVAILABLE이라 DB 오류도 "AI 응답 생성이 지연" 문구로 나가
 * 화면만 보고는 원인을 좁힐 수 없었다.
 */
import { ErrorCodes } from '../../../global/common/exception/error-code.registry';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { LlmExhaustedError } from '../../../infrastructure/llm/llm-gateway';
import { LlmProviderError } from '../../../infrastructure/llm/llm-provider.port';
import {
  RETRYABLE_STREAM_FAILURES,
  StreamTimeoutError,
  classifyStreamFailure,
} from './conversation-stream.service';

describe('classifyStreamFailure', () => {
  it('전 프로바이더 소진은 LLM_UNAVAILABLE', () => {
    expect(classifyStreamFailure(new LlmExhaustedError())).toBe('LLM_UNAVAILABLE');
  });

  it('첫 토큰 이후 실패로 폴백 불가한 프로바이더 오류도 LLM_UNAVAILABLE', () => {
    expect(classifyStreamFailure(new LlmProviderError('provider down'))).toBe('LLM_UNAVAILABLE');
  });

  it('전체 상한 초과는 LLM_TIMEOUT — 프로바이더 장애와 구분한다', () => {
    expect(classifyStreamFailure(new StreamTimeoutError())).toBe('LLM_TIMEOUT');
  });

  it('도메인 계약 위반은 자기 코드를 유지한다', () => {
    expect(classifyStreamFailure(new ServiceException('NOT_FOUND'))).toBe('NOT_FOUND');
    expect(classifyStreamFailure(new ServiceException('PATIENT_ARCHIVED'))).toBe(
      'PATIENT_ARCHIVED',
    );
  });

  it('DB·영속화 등 예상 못한 실패는 INTERNAL_ERROR — LLM 탓으로 돌리지 않는다', () => {
    const dbError = Object.assign(new Error('deadlock detected'), { code: '40P01' });

    expect(classifyStreamFailure(dbError)).toBe('INTERNAL_ERROR');
    expect(classifyStreamFailure('문자열 throw')).toBe('INTERNAL_ERROR');
  });
});

describe('RETRYABLE_STREAM_FAILURES', () => {
  it('상류 장애만 재시도 대상이다', () => {
    expect(RETRYABLE_STREAM_FAILURES.has('LLM_UNAVAILABLE')).toBe(true);
    expect(RETRYABLE_STREAM_FAILURES.has('LLM_TIMEOUT')).toBe(true);
  });

  it('우리 쪽 결함·계약 위반은 재시도 대상이 아니다', () => {
    expect(RETRYABLE_STREAM_FAILURES.has('INTERNAL_ERROR')).toBe(false);
    expect(RETRYABLE_STREAM_FAILURES.has('NOT_FOUND')).toBe(false);
  });
});

describe('LLM 오류코드 문구', () => {
  it('지연 문구는 LLM_TIMEOUT이 갖고, 소진은 이용 불가로 구분한다', () => {
    expect(ErrorCodes.LLM_TIMEOUT.message).toContain('지연');
    expect(ErrorCodes.LLM_UNAVAILABLE.message).not.toContain('지연');
    // 둘 다 503이다 — §10.1 허용 status 집합에 504가 없어 구분은 code가 진다
    expect(ErrorCodes.LLM_TIMEOUT.status).toBe(503);
    expect(ErrorCodes.LLM_UNAVAILABLE.status).toBe(503);
  });
});
