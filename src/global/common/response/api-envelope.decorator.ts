import { Type, applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ApiResponseDto } from './api-response.dto';
import { PageMetaDto } from './page-meta.dto';

/**
 * OpenAPI에 봉투를 구체 타입으로 기록한다 (architecture.md §10.1).
 * TS generic은 런타임에 소거되므로 allOf + getSchemaPath로 data 타입을 명시한다.
 */
export function ApiEnvelopeResponse<TModel extends Type<unknown>>(
  model: TModel,
  /**
   * `isArray`는 **커서 없는 소규모 전건 목록**을 위한 것이다 (docs/specs/36 구성원 목록).
   * §10.4가 커서 + `PageMetaDto`를 강제하는 대상은 환자·대화·초대처럼 탐색이 필요한 목록이며,
   * 클리닉 구성원처럼 전건이 한 화면에 들어오는 목록까지 커서를 씌우면 계약만 무거워진다.
   * 페이지네이션이 필요한 목록은 여전히 `ApiPageResponse`를 쓴다.
   */
  options: { status?: number; isArray?: boolean } = {},
) {
  return applyDecorators(
    ApiExtraModels(ApiResponseDto, model),
    ApiResponse({
      status: options.status ?? 200,
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiResponseDto) },
          {
            properties: {
              data: options.isArray
                ? { type: 'array', items: { $ref: getSchemaPath(model) } }
                : { $ref: getSchemaPath(model) },
            },
          },
        ],
      },
    }),
  );
}

/** 커서 목록 응답: data: Model[] + page: PageMetaDto */
export function ApiPageResponse<TModel extends Type<unknown>>(model: TModel) {
  return applyDecorators(
    ApiExtraModels(ApiResponseDto, PageMetaDto, model),
    ApiResponse({
      status: 200,
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiResponseDto) },
          {
            properties: {
              data: { type: 'array', items: { $ref: getSchemaPath(model) } },
              page: { $ref: getSchemaPath(PageMetaDto) },
            },
          },
        ],
      },
    }),
  );
}
