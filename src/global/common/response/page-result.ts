import { PageMetaDto } from './page-meta.dto';

/**
 * 서비스 계층이 목록 조회 결과를 담아 반환하는 컨테이너.
 * ApiResponseInterceptor가 data: items + page: meta 봉투로 변환한다.
 */
export class PageResult<T> {
  private constructor(
    readonly items: T[],
    readonly meta: PageMetaDto,
  ) {}

  static of<T>(items: T[], meta: { size: number; hasNext: boolean; nextCursor: string | null }): PageResult<T> {
    return new PageResult(items, meta);
  }
}
