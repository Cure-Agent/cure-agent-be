import { Injectable } from '@nestjs/common';
import { NckmConfig } from './nckm.config';
import {
  GuidelineSourcePort,
  ListOptions,
  SourceDownload,
  SourceListItem,
} from './guideline-source.port';

/**
 * NCKM 실 구현 (docs/specs/18).
 * 판정하지 않는다 — 받아온 것을 그대로 넘긴다.
 */
@Injectable()
export class NckmGuidelineSource implements GuidelineSourcePort {
  readonly system = 'NCKM';

  constructor(private readonly config: NckmConfig) {}

  listGuidelines(_options?: ListOptions): Promise<SourceListItem[]> {
    throw new Error('not implemented');
  }

  download(_item: SourceListItem): Promise<SourceDownload> {
    throw new Error('not implemented');
  }
}
