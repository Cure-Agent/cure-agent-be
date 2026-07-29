import { Injectable } from '@nestjs/common';
import { decodeCursor, encodeCursor } from '../../../global/common/cursor/cursor.util';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { PageResult } from '../../../global/common/response/page-result';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { ListAdminGuidelinesQueryDto } from '../dto/request/list-admin-guidelines.query.dto';
import { RunPipelineRequestDto } from '../dto/request/run-pipeline.request.dto';
import { UpdateVersionStatusRequestDto } from '../dto/request/update-version-status.request.dto';
import { AdminGuidelineVersionResponseDto } from '../dto/response/admin-guideline-version.response.dto';
import { AdminGuidelineResponseDto } from '../dto/response/admin-guideline.response.dto';
import { AdminIngestResponseDto } from '../dto/response/admin-ingest.response.dto';
import { toAdminGuideline, toAdminGuidelineVersion } from '../mapper/guideline.mapper';
import { GuidelineVersionRow } from '../persistence/guideline.schema';
import { GuidelineRepository } from '../repository/guideline.repository';
import { GuidelinePipelineService } from './guideline-pipeline.service';

const DEFAULT_SIZE = 20;

interface GuidelineCursor extends Record<string, unknown> {
  id: string;
}

/**
 * 지침 코퍼스 관리 유스케이스 (docs/specs/21).
 *
 * 파싱과 적재를 합치고 적재 전 검토 경로는 두지 않는다 — §20 실패 가드가 구조 문제를 막고,
 * 이 스텝의 revision·SUPERSEDED·삭제가 "적재 후 되돌리기"를 제공하기 때문이다.
 */
@Injectable()
export class GuidelineAdminService {
  constructor(
    private readonly txManager: TransactionManager,
    private readonly repository: GuidelineRepository,
    // 1건 동기 경로와 전건 잡이 같은 실행기를 공유한다 (docs/specs/22)
    private readonly pipeline: GuidelinePipelineService,
  ) {}

  /**
   * 1건 수집→파싱→적재. PDF는 메모리에서 파싱하고 버린다 — 디스크에 쓰면 누적된다.
   *
   * **§22의 실행기에 위임한다.** 그래서 이 동기 호출도 `jobId=null` 실행 행으로 남아
   * `GET /admin/pipeline-runs`에 전건 잡의 실행들과 함께 조회된다 — 1건 경로와 전건 경로가
   * 같은 기록 구조를 쓴다는 §22의 전제가 여기서 성립한다.
   *
   * 실패는 실행 행에 기록된 뒤 **원래 예외 그대로** 다시 던진다 — 동기 계약은 HTTP 상태로
   * 답해야 하고, §20 가드가 `data`에 실은 문제 권고 번호도 그래야 보존된다.
   */
  async runPipeline(request: RunPipelineRequestDto): Promise<AdminIngestResponseDto> {
    const { run, error } = await this.pipeline.runOne({
      externalId: request.guideIdx,
      jobId: null,
      order: 0,
    });
    if (error) throw error;

    // 첨부가 없는 문서는 에러가 아니다 — 수집 기록만 남기고 그 상태를 돌려준다
    if (run.status === 'SKIPPED') {
      return {
        externalId: request.guideIdx,
        sourceStatus: 'SKIPPED_NO_ATTACHMENT',
        created: false,
        guidelineId: null,
        guidelineVersionId: null,
        version: null,
        revision: null,
        status: null,
        stats: null,
      };
    }

    // 판본·상태는 행이 아니라 버전에서 읽는다 — 재적재 skip이면 기존 버전을 그대로 가리키므로
    // 그 버전이 이미 폐기됐을 수도 있다(하드코딩하면 거짓이 된다)
    const version = run.guidelineVersionId
      ? await this.repository.findVersionById(run.guidelineVersionId)
      : null;
    const ingest = run.stages.ingest;

    return {
      externalId: request.guideIdx,
      sourceStatus: 'FETCHED',
      created: run.created ?? false,
      guidelineId: run.guidelineId,
      guidelineVersionId: run.guidelineVersionId,
      version: version?.version ?? null,
      revision: run.revision,
      status: version?.status ?? null,
      stats: ingest
        ? {
            sections: ingest.sections,
            chunks: ingest.chunks,
            skippedChunks: ingest.skippedChunks,
          }
        : null,
    };
  }

  async listGuidelines(
    query: ListAdminGuidelinesQueryDto,
  ): Promise<PageResult<AdminGuidelineResponseDto>> {
    const size = query.size ?? DEFAULT_SIZE;
    const afterId = query.cursor ? decodeCursor<GuidelineCursor>(query.cursor).id : undefined;

    // limit+1로 다음 페이지 존재 여부 판단
    const rows = await this.repository.listGuidelinesForAdmin({
      query: query.query,
      publisher: query.publisher,
      afterId,
      limit: size + 1,
    });
    const hasNext = rows.length > size;
    const page = rows.slice(0, size);

    // 버전은 서브리소스가 아니다 — 지침당 몇 행이라 한 번에 읽어 중첩한다
    const versions = await this.repository.listVersionsWithChunkCount(page.map((g) => g.id));
    const byGuideline = new Map<string, (GuidelineVersionRow & { chunkCount: number })[]>();
    for (const version of versions) {
      const bucket = byGuideline.get(version.guidelineId);
      if (bucket) bucket.push(version);
      else byGuideline.set(version.guidelineId, [version]);
    }

    return PageResult.of(
      page.map((guideline) => toAdminGuideline(guideline, byGuideline.get(guideline.id) ?? [])),
      {
        size,
        hasNext,
        nextCursor: hasNext ? encodeCursor({ id: page[page.length - 1].id }) : null,
      },
    );
  }

  /**
   * 요청한 버전의 status만 바꾼다 — 승격이 같은 판본의 다른 revision을 내리지 않는다.
   * 한 번의 PATCH가 명시하지 않은 행을 바꾸지 않는 편이 예측 가능하다 (docs/specs/21).
   */
  async updateVersionStatus(
    versionId: string,
    request: UpdateVersionStatusRequestDto,
  ): Promise<AdminGuidelineVersionResponseDto> {
    const version = await this.repository.findVersionById(versionId);
    if (!version) throw new ServiceException('NOT_FOUND');

    await this.repository.updateVersionStatus(versionId, request.status);
    const chunkCount = await this.repository.countChunks(versionId);
    return toAdminGuidelineVersion({ ...version, status: request.status, chunkCount });
  }

  /** 인용된 청크가 하나라도 있으면 409로 거부하고 아무것도 지우지 않는다 (부분 삭제 금지). */
  async deleteVersion(versionId: string): Promise<void> {
    const version = await this.repository.findVersionById(versionId);
    if (!version) throw new ServiceException('NOT_FOUND');

    // 과거 답변은 실제로 그 청크로 생성됐다 — 지우면 인용이 거짓이 된다. 폐기가 기본 수단이다.
    if ((await this.repository.countCitations(versionId)) > 0) {
      throw new ServiceException('GUIDELINE_VERSION_CITED');
    }

    await this.txManager.run(async () => {
      await this.repository.deleteVersionCascade(versionId);
      // 마지막 버전이었다면 빈 지침 행을 남기지 않는다
      if ((await this.repository.countVersions(version.guidelineId)) === 0) {
        await this.repository.deleteGuideline(version.guidelineId);
      }
    });
  }
}
