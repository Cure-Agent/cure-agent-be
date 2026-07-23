import { ApiProperty } from '@nestjs/swagger';
import { ErrorCode, ErrorCodes } from '../exception/error-code.registry';
import { PageMetaDto } from './page-meta.dto';
import { PageResult } from './page-result';
import { SuccessCode, SuccessCodes } from './success-code.registry';

/**
 * 공통 응답 봉투 (architecture.md §10.1)
 * traceId는 ApiResponseInterceptor / ApiExceptionFilter가 CLS에서 채운다.
 */
export class ApiResponseDto<T> {
  @ApiProperty({ description: '비즈니스 성공 여부' })
  success!: boolean;

  @ApiProperty({ description: '코드 레지스트리 기반 식별자 (FE 분기용)' })
  code!: string;

  @ApiProperty({ description: '사용자 표시용 메시지' })
  message!: string;

  data!: T | null;

  @ApiProperty({ type: PageMetaDto, nullable: true })
  page!: PageMetaDto | null;

  @ApiProperty({ description: '응답 생성 시각 (ISO 8601)' })
  timestamp!: string;

  @ApiProperty({ description: '요청 추적 ID (로그·알림과 연결)' })
  traceId!: string;

  private static base<T>(partial: Omit<ApiResponseDto<T>, 'timestamp' | 'traceId'>): ApiResponseDto<T> {
    const dto = new ApiResponseDto<T>();
    Object.assign(dto, partial);
    dto.timestamp = new Date().toISOString();
    dto.traceId = '';
    return dto;
  }

  static success<T>(data: T, code: SuccessCode = 'SUCCESS'): ApiResponseDto<T> {
    return this.base({
      success: true,
      code,
      message: SuccessCodes[code].message,
      data,
      page: null,
    });
  }

  static successPage<T>(result: PageResult<T>, code: SuccessCode = 'SUCCESS'): ApiResponseDto<T[]> {
    return this.base({
      success: true,
      code,
      message: SuccessCodes[code].message,
      data: result.items,
      page: result.meta,
    });
  }

  static failure(code: ErrorCode, data?: unknown): ApiResponseDto<unknown> {
    return this.base({
      success: false,
      code,
      message: ErrorCodes[code].message,
      data: data ?? null,
      page: null,
    });
  }
}
