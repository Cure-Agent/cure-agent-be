import { Injectable } from '@nestjs/common';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { decodeCursor, encodeCursor } from '../../../global/common/cursor/cursor.util';
import { PageResult } from '../../../global/common/response/page-result';
import { ListEvidenceQueryDto } from '../dto/request/list-evidence.query.dto';
import { ListGuidelinesQueryDto } from '../dto/request/list-guidelines.query.dto';
import { EvidenceDetailResponseDto } from '../dto/response/evidence-detail.response.dto';
import { EvidenceSummaryResponseDto } from '../dto/response/evidence-summary.response.dto';
import { GuidelineDetailResponseDto } from '../dto/response/guideline-detail.response.dto';
import { GuidelineSummaryResponseDto } from '../dto/response/guideline-summary.response.dto';
import {
  toEvidenceDetail,
  toEvidenceSummary,
  toGuidelineDetail,
  toGuidelineSummary,
} from '../mapper/guideline.mapper';
import { GuidelineRepository } from '../repository/guideline.repository';

const DEFAULT_SIZE = 20;

interface GuidelineCursor extends Record<string, unknown> {
  id: string;
}

@Injectable()
export class GuidelineService {
  constructor(private readonly repository: GuidelineRepository) {}

  async list(query: ListGuidelinesQueryDto): Promise<PageResult<GuidelineSummaryResponseDto>> {
    const size = query.size ?? DEFAULT_SIZE;
    const afterId = query.cursor ? decodeCursor<GuidelineCursor>(query.cursor).id : undefined;

    // limit+1로 다음 페이지 존재 여부 판단
    const rows = await this.repository.listGuidelines({
      query: query.query,
      status: query.status,
      publisher: query.publisher,
      afterId,
      limit: size + 1,
    });
    const hasNext = rows.length > size;
    const page = rows.slice(0, size);

    const latestVersions = await this.repository.findLatestVersions(page.map((g) => g.id));
    const items = page.map((guideline) => {
      const version = latestVersions.get(guideline.id);
      if (!version) throw new ServiceException('INTERNAL_ERROR', { reason: 'VERSION_MISSING' });
      return toGuidelineSummary(guideline, version);
    });

    return PageResult.of(items, {
      size,
      hasNext,
      nextCursor: hasNext ? encodeCursor({ id: page[page.length - 1].id }) : null,
    });
  }

  async detail(guidelineId: string): Promise<GuidelineDetailResponseDto> {
    const guideline = await this.repository.findGuidelineById(guidelineId);
    if (!guideline) throw new ServiceException('NOT_FOUND');

    const version = (await this.repository.findLatestVersions([guideline.id])).get(guideline.id);
    if (!version) throw new ServiceException('NOT_FOUND');

    return toGuidelineDetail(guideline, version);
  }

  async listEvidence(
    guidelineId: string,
    query: ListEvidenceQueryDto,
  ): Promise<PageResult<EvidenceSummaryResponseDto>> {
    const guideline = await this.repository.findGuidelineById(guidelineId);
    if (!guideline) throw new ServiceException('NOT_FOUND');
    const version = (await this.repository.findLatestVersions([guideline.id])).get(guideline.id);
    if (!version) throw new ServiceException('NOT_FOUND');

    const size = query.size ?? DEFAULT_SIZE;
    const afterId = query.cursor ? decodeCursor<GuidelineCursor>(query.cursor).id : undefined;

    const rows = await this.repository.listEvidence({
      guidelineVersionId: version.id,
      afterId,
      limit: size + 1,
    });
    const hasNext = rows.length > size;
    const page = rows.slice(0, size);

    return PageResult.of(
      page.map(({ chunk, section }) => toEvidenceSummary(chunk, section)),
      {
        size,
        hasNext,
        nextCursor: hasNext ? encodeCursor({ id: page[page.length - 1].chunk.id }) : null,
      },
    );
  }

  async evidenceDetail(evidenceId: string): Promise<EvidenceDetailResponseDto> {
    const row = await this.repository.findEvidenceDetail(evidenceId);
    if (!row) throw new ServiceException('NOT_FOUND');
    return toEvidenceDetail(row);
  }
}
