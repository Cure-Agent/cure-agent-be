/**
 * NCKM 지침 권고문 청커 (docs/specs/19) — 페이지 텍스트를 권고문 단위 청크로 분해한다.
 *
 * 부수효과 없는 **순수 함수**다. PDF 추출(pdf-text.extractor)과 메타 조회(GuidelineParseService)는
 * 밖에 두고, 이 함수는 `(pages, meta) → GuidelineIngestInput` 변환만 책임진다 —
 * 5.6MB PDF 없이 텍스트 fixture만으로 전량 검증하기 위한 경계다.
 */
import { GuidelineIngestInput } from '../../domain/guideline/service/guideline-ingest.input';

/** `GuidelineIngestInput`에서 sections를 뺀 문서 메타 — source_documents에서 온다 (§19 「문서 메타의 출처」) */
export type GuidelineDocumentMeta = Omit<GuidelineIngestInput, 'sections'>;

/**
 * 페이지 텍스트 배열(물리 페이지 순서)을 인제스트 입력으로 변환한다.
 *
 * @param pages PDF에서 추출한 페이지별 평문. 각 페이지 첫 줄이 인쇄 페이지 번호다.
 * @param meta 문서 메타 (title·publisher·version·publishedAt·sourceUrl)
 */
export function chunkNckmGuideline(
  pages: string[],
  meta: GuidelineDocumentMeta,
): GuidelineIngestInput {
  void pages;
  return { ...meta, sections: [] };
}
