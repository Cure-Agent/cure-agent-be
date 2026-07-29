import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { TransactionManager } from '../../../global/database/transaction-manager';
import {
  EMBEDDING_PROVIDER,
  EmbeddingProvider,
} from '../../../infrastructure/embedding/embedding-provider.port';
import { GuidelineRepository } from '../repository/guideline.repository';
import { PipelineRunRepository } from '../repository/pipeline-run.repository';
import {
  GuidelineEmbedOutcome,
  GuidelineIngestInput,
  GuidelineIngestResult,
  PreparedIngestChunk,
} from './guideline-ingest.input';

/**
 * 구조화 JSON 인제스트 (docs/specs/05).
 * - guideline은 (title, publisher) upsert, 동일 내용 재인제스트는 skip (멱등)
 * - 임베딩은 트랜잭션 밖에서 일괄 계산 후 저장
 *
 * 파이프라인(docs/specs/22)이 EMBED와 INGEST를 별도 phase로 계측해야 해서
 * `embed()`(계산) / `persist()`(쓰기) 두 공개 메서드로 나뉘어 있고,
 * `ingest()`는 그 둘을 이어 붙인 **§05 JSON 인제스트 진입점**이다.
 * 수집·파싱을 거치는 경로(§21 1건 동기, §22 전건 잡)는 `GuidelinePipelineService`가
 * `embed`/`persist`를 직접 불러 단계별로 계측하므로 이 메서드를 타지 않는다.
 */
@Injectable()
export class GuidelineIngestService {
  constructor(
    private readonly txManager: TransactionManager,
    private readonly repository: GuidelineRepository,
    private readonly runs: PipelineRunRepository,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  /**
   * §05 JSON 인제스트 — 구조화 입력을 바로 적재한다.
   *
   * **실행 기록을 `pipeline_runs`에 남긴다**(`jobId=null`·`externalId=null`). docs/specs/22가
   * 「job_id = NULL → 잡 밖의 실행(§21 1건 동기, **§05 스크립트**)」로 이 경로를 명시했고,
   * `sourceSystem`·`externalId`를 nullable로 둔 것도 「§05 JSON 인제스트에는 원본 식별자가
   * 없다」는 이유였다. 수집·파싱 단계가 없으므로 `phase`는 `INGEST`에서 시작해 그대로 끝난다.
   */
  async ingest(input: GuidelineIngestInput): Promise<GuidelineIngestResult> {
    const run = await this.runs.insertRunning({
      id: ulid(),
      jobId: null,
      order: 0,
      sourceSystem: null,
      externalId: null,
    });
    const startedAt = Date.now();

    try {
      const result = await this.persist(await this.embed(input));
      await this.runs.finalizeRun(run.id, {
        status: 'SUCCEEDED',
        phase: 'INGEST',
        guidelineId: result.guidelineId,
        guidelineVersionId: result.guidelineVersionId,
        revision: result.revision,
        created: result.created,
        stages: { ingest: { ...result.stats, ms: Date.now() - startedAt } },
      });
      return result;
    } catch (error) {
      const code = error instanceof ServiceException ? error.code : 'INTERNAL_ERROR';
      await this.runs.finalizeRun(run.id, {
        status: 'FAILED',
        phase: 'INGEST',
        errorCode: code,
        error: String(error).slice(0, 2000),
      });
      throw error;
    }
  }

  /**
   * EMBED 구간 — 검증 · 재적재 판정 · dedupe · 임베딩 호출까지. DB 쓰기는 하지 않는다.
   * 임베딩 프로바이더 예외는 잡지 않고 그대로 올린다 — 상위가 phase=EMBED로 분류해야 한다.
   */
  async embed(input: GuidelineIngestInput): Promise<GuidelineEmbedOutcome> {
    this.validate(input);
    const inputHash = sha256(JSON.stringify(input));

    const existingGuideline = await this.repository.findByTitlePublisher(
      input.title,
      input.publisher,
    );
    const guidelineId = existingGuideline?.id ?? ulid();

    // 동일 내용 재인제스트 → 새 revision 없이 skip (docs/specs/05 수용 기준 2의 멱등성).
    // 기준은 판본이 아니라 **내용 해시**다 — 파서가 좋아지면 같은 판본도 새 revision이 된다 (docs/specs/21).
    let revision = 1;
    if (existingGuideline) {
      const sameContent = await this.repository.findVersionByContentHash(
        guidelineId,
        input.version,
        inputHash,
      );
      // 여기서 즉시 반환한다 — skip은 임베딩을 한 건도 호출하지 않아야 한다 (docs/specs/22).
      if (sameContent) {
        const skippedChunks = input.sections.reduce((sum, s) => sum + s.chunks.length, 0);
        return {
          kind: 'skip',
          result: {
            guidelineId,
            guidelineVersionId: sameContent.id,
            created: false,
            revision: sameContent.revision,
            status: sameContent.status,
            version: sameContent.version,
            stats: { sections: 0, chunks: 0, skippedChunks },
          },
        };
      }
      revision = (await this.repository.findMaxRevision(guidelineId, input.version)) + 1;
    }

    // 버전 내 중복 콘텐츠 dedupe 후 임베딩 일괄 계산 (트랜잭션 밖)
    const chunks: PreparedIngestChunk[] = [];
    const seenHashes = new Set<string>();
    let skippedChunks = 0;
    input.sections.forEach((section, sectionIndex) => {
      section.chunks.forEach((chunk, chunkIndex) => {
        const contentHash = sha256(chunk.content);
        if (seenHashes.has(contentHash)) {
          skippedChunks += 1;
          return;
        }
        seenHashes.add(contentHash);
        chunks.push({
          sectionIndex,
          content: chunk.content,
          contentHash,
          order: chunkIndex,
          recommendationNumber: chunk.recommendationNumber ?? null,
          recommendationGrade: chunk.recommendationGrade ?? null,
          evidenceLevel: chunk.evidenceLevel ?? null,
          pageStart: chunk.pageStart ?? null,
          pageEnd: chunk.pageEnd ?? null,
        });
      });
    });
    const embeddings = await this.embeddingProvider.embed(chunks.map((c) => c.content));

    return {
      kind: 'write',
      input,
      inputHash,
      guidelineId,
      guidelineExists: existingGuideline !== null,
      revision,
      chunks,
      embeddings,
      skippedChunks,
      // 모델은 호출 시점 값을 박아 둔다 — persist는 이 벡터를 만든 좌표계를 그대로 기록해야 한다.
      embed: { vectors: chunks.length, model: this.embeddingProvider.model },
    };
  }

  /** INGEST 구간 — 한 트랜잭션 안에서 guideline/version/section/chunk 쓰기와 supersede. */
  async persist(outcome: GuidelineEmbedOutcome): Promise<GuidelineIngestResult> {
    if (outcome.kind === 'skip') return outcome.result;

    const { input, inputHash, guidelineId, revision, chunks, embeddings } = outcome;
    const guidelineVersionId = ulid();
    const stats = {
      sections: input.sections.length,
      chunks: chunks.length,
      skippedChunks: outcome.skippedChunks,
    };

    await this.txManager.run(async () => {
      if (!outcome.guidelineExists) {
        await this.repository.insertGuideline({
          id: guidelineId,
          title: input.title,
          publisher: input.publisher,
        });
      }
      await this.repository.insertVersion({
        id: guidelineVersionId,
        guidelineId,
        version: input.version,
        revision,
        status: 'ACTIVE',
        publishedAt: new Date(input.publishedAt),
        sourceUrl: input.sourceUrl,
        contentHash: inputHash,
      });
      // 새 revision이 ACTIVE가 되면 직전 revision은 내려간다 — 같은 판본 안에서만이다 (docs/specs/21).
      // 이전 revision의 청크는 지우지 않는다: 과거 답변이 실제로 그 청크로 생성됐다.
      if (revision > 1) {
        await this.repository.supersedeOtherRevisions(
          guidelineId,
          input.version,
          guidelineVersionId,
        );
      }

      const sectionIds: string[] = [];
      for (const [index, section] of input.sections.entries()) {
        const sectionId = ulid();
        sectionIds[index] = sectionId;
        await this.repository.insertSection({
          id: sectionId,
          guidelineVersionId,
          title: section.title,
          path: section.path,
          order: section.order,
        });
      }

      await this.repository.insertChunks(
        chunks.map((chunk, index) => ({
          id: ulid(),
          sectionId: sectionIds[chunk.sectionIndex],
          guidelineVersionId,
          content: chunk.content,
          embedding: embeddings[index],
          // 벡터 좌표계 출처 — 검색은 같은 모델의 청크만 본다 (docs/specs/14)
          embeddingModel: outcome.embed.model,
          recommendationNumber: chunk.recommendationNumber,
          recommendationGrade: chunk.recommendationGrade,
          evidenceLevel: chunk.evidenceLevel,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          order: chunk.order,
          contentHash: chunk.contentHash,
        })),
      );
    });

    return {
      guidelineId,
      guidelineVersionId,
      created: true,
      revision,
      status: 'ACTIVE',
      version: input.version,
      stats,
    };
  }

  private validate(input: GuidelineIngestInput): void {
    const problems: string[] = [];
    for (const field of ['title', 'publisher', 'version', 'sourceUrl'] as const) {
      if (typeof input[field] !== 'string' || input[field].length === 0) {
        problems.push(`${field} 누락`);
      }
    }
    if (Number.isNaN(Date.parse(input.publishedAt))) problems.push('publishedAt 형식 오류');
    if (!Array.isArray(input.sections) || input.sections.length === 0) {
      problems.push('sections 비어 있음');
    } else {
      input.sections.forEach((section, i) => {
        if (!Array.isArray(section.path) || section.path.length === 0)
          problems.push(`sections[${i}].path 누락`);
        if (!section.title) problems.push(`sections[${i}].title 누락`);
        (section.chunks ?? []).forEach((chunk, j) => {
          if (!chunk.content) problems.push(`sections[${i}].chunks[${j}].content 누락`);
        });
      });
    }
    if (problems.length > 0) {
      throw new ServiceException('BAD_REQUEST', { reason: 'INVALID_INGEST_INPUT', problems });
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
