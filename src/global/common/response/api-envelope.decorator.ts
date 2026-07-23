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
  options: { status?: number } = {},
) {
  return applyDecorators(
    ApiExtraModels(ApiResponseDto, model),
    ApiResponse({
      status: options.status ?? 200,
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiResponseDto) },
          {
            properties: { data: { $ref: getSchemaPath(model) } },
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
