import { Inject, Injectable } from '@nestjs/common';
import { GUIDELINE_SOURCE, GuidelineSourcePort } from '../../../infrastructure/guideline-source/guideline-source.port';
import { SourceDocumentRepository } from '../repository/source-document.repository';
import { SourceDocumentStatus } from '../persistence/source-document.schema';

export interface AcquireOptions {
  limit?: number;
  externalIds?: string[];
  /** 다운로드한 PDF를 쓸 디렉토리. 미지정이면 파일을 쓰지 않는다. */
  outDir?: string;
}

export interface AcquireItemResult {
  externalId: string;
  status: SourceDocumentStatus;
  /** 기존 행과 같은 해시라 새로 저장하지 않은 경우 true */
  unchanged: boolean;
}

export interface AcquireResult {
  total: number;
  fetched: number;
  skipped: number;
  failed: number;
  unchanged: number;
  items: AcquireItemResult[];
}

/**
 * 지침 원본 수집 (docs/specs/18).
 * 포트는 받아온 것만 넘기고, 상태 판정(FETCHED/SKIPPED_NO_ATTACHMENT/FAILED)과
 * 매직바이트 검사는 여기서 한다. 개별 문서 실패가 배치를 중단시키지 않는다.
 */
@Injectable()
export class GuidelineAcquisitionService {
  constructor(
    @Inject(GUIDELINE_SOURCE) private readonly source: GuidelineSourcePort,
    private readonly repository: SourceDocumentRepository,
  ) {}

  acquire(_options: AcquireOptions = {}): Promise<AcquireResult> {
    throw new Error('not implemented');
  }
}
