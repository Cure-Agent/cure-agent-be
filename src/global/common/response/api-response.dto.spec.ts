import { ApiResponseDto } from './api-response.dto';
import { PageResult } from './page-result';

describe('ApiResponseDto', () => {
  it('success: 봉투 필드가 계약(§10.1)대로 채워진다', () => {
    const res = ApiResponseDto.success({ id: '1' });
    expect(res.success).toBe(true);
    expect(res.code).toBe('SUCCESS');
    expect(res.message).toBe('요청에 성공하였습니다.');
    expect(res.data).toEqual({ id: '1' });
    expect(res.page).toBeNull();
    expect(new Date(res.timestamp).toISOString()).toBe(res.timestamp);
  });

  it('successPage: data는 배열, page에 메타가 실린다', () => {
    const result = PageResult.of([{ id: '1' }], { size: 1, hasNext: true, nextCursor: 'abc' });
    const res = ApiResponseDto.successPage(result);
    expect(res.data).toEqual([{ id: '1' }]);
    expect(res.page).toEqual({ size: 1, hasNext: true, nextCursor: 'abc' });
  });

  it('failure: 레지스트리 메시지와 보조 data를 싣는다', () => {
    const res = ApiResponseDto.failure('PATIENT_VERSION_CONFLICT', { currentVersion: 4 });
    expect(res.success).toBe(false);
    expect(res.code).toBe('PATIENT_VERSION_CONFLICT');
    expect(res.message).toBe('다른 사용자가 환자 정보를 먼저 수정했습니다.');
    expect(res.data).toEqual({ currentVersion: 4 });
  });

  it('failure: data 미지정 시 null', () => {
    expect(ApiResponseDto.failure('NOT_FOUND').data).toBeNull();
  });
});
