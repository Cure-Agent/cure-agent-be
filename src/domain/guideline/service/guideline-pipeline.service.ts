import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { ErrorCode } from '../../../global/common/exception/error-code.registry';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { MetricsService } from '../../../global/observability/metrics/metrics.service';
import { containsRecommendationMarker } from '../../../infrastructure/document/guideline-chunker';
import { PdfTextExtractor } from '../../../infrastructure/document/pdf-text.extractor';
import {
  PipelineRunPhase,
  PipelineRunRow,
  PipelineRunStages,
} from '../persistence/guideline-job.schema';
import { PipelineRunRepository } from '../repository/pipeline-run.repository';
import { GuidelineAcquisitionService } from './guideline-acquisition.service';
import { GuidelineIngestService } from './guideline-ingest.service';
import { GuidelineParseService } from './guideline-parse.service';

/** 단계 진입·종결마다 호출된다 — 러너가 SSE로 중계한다. 잡 밖 실행은 넘기지 않는다 */
export type RunStageListener = (run: PipelineRunRow) => void | Promise<void>;

export interface RunPipelineOptions {
  externalId: string;
  /** null이면 잡 밖의 단건 실행 (docs/specs/21 동기 pipeline) */
  jobId: string | null;
  order: number;
  onStage?: RunStageListener;
}

export interface PipelineRunOutcome {
  run: PipelineRunRow;
  /**
   * 실패했을 때의 원래 예외. **1건 동기 경로가 이걸 그대로 던져야** §20 가드가 `data`에 실은
   * 문제 권고 번호가 보존된다 — 행에는 코드와 문자열만 남아 그 정보가 사라진다.
   * 잡 러너는 무시한다: 개별 문서의 실패가 잡을 멈추지 않는다.
   */
  error?: ServiceException;
}

/** 단계별 기본 실패 코드 — 예외가 ServiceException이면 그 코드를 존중한다 */
const PHASE_FAILURE: Record<PipelineRunPhase, ErrorCode> = {
  ACQUIRE: 'GUIDELINE_SOURCE_UNAVAILABLE',
  PARSE: 'GUIDELINE_PARSE_FAILED',
  EMBED: 'GUIDELINE_EMBEDDING_FAILED',
  INGEST: 'INTERNAL_ERROR',
};

/**
 * 문서 1건의 수집→파싱→임베딩→적재 (docs/specs/22).
 *
 * **1건 동기 경로와 전건 잡이 이 실행기를 공유한다.** 그래서 §21의 `POST /admin/guidelines/pipeline`
 * 호출도 `jobId=null` 실행 행으로 남아 `GET /admin/pipeline-runs`에 함께 조회된다 —
 * 수용 기준 13의 구조적 보장이다.
 *
 * **run 행은 문서를 시작할 때 만들고 단계마다 갱신한다.** 끝날 때 한 번 쓰면 처리 도중 죽은
 * 그 문서만 기록이 없어, 「어디까지 갔는지는 pipeline_runs에 남는다」가 정작 필요한 순간에
 * 성립하지 않는다. 이 증분 저장이 곧 `run.stage` 이벤트의 원천이기도 하다.
 *
 * **실패는 예외 타입이 아니라 단계로 분류한다** — 진행 중인 단계를 추적해 매핑하므로, 임베딩
 * 프로바이더가 평범한 `Error`를 던져도 `GUIDELINE_EMBEDDING_FAILED`가 된다 (§18 수집이 타입을
 * 보지 않고 다운로드 실패를 전부 FAILED로 기록하는 것과 같은 규칙).
 */
@Injectable()
export class GuidelinePipelineService {
  constructor(
    private readonly runs: PipelineRunRepository,
    private readonly acquisition: GuidelineAcquisitionService,
    private readonly parseService: GuidelineParseService,
    private readonly ingestService: GuidelineIngestService,
    private readonly pdfExtractor: PdfTextExtractor,
    private readonly metrics: MetricsService,
  ) {}

  async runOne(options: RunPipelineOptions): Promise<PipelineRunOutcome> {
    // ACQUIRE 진입 — 아직 산출이 없어 stages는 비어 있다
    let run = await this.runs.insertRunning({
      id: ulid(),
      jobId: options.jobId,
      order: options.order,
      sourceSystem: this.acquisition.sourceSystem,
      externalId: options.externalId,
    });
    await options.onStage?.(run);

    let phase: PipelineRunPhase = 'ACQUIRE';

    try {
      // ── ACQUIRE ──────────────────────────────────────────
      const acquireStart = Date.now();
      const acquired = await this.acquisition.acquireDocument(options.externalId);
      const acquireMs = Date.now() - acquireStart;

      // 원본 목록에 「없는 것」과 「못 가져온 것」을 구분한다 (§21의 구분을 잡 경로에서도 유지)
      if (!acquired) {
        return await this.fail(
          options,
          run,
          phase,
          new ServiceException('NOT_FOUND'),
        );
      }
      if (acquired.status === 'FAILED') {
        // 수집이 남긴 사유를 detail로 실어 `pipeline_runs.error`까지 가져간다 — 코드만 남으면
        // 「지침 원본을 가져오지 못했습니다.」뿐이라 HTTP 상태도 원인도 알 수 없다.
        // detail은 응답 봉투에 쓰이지 않으므로(`service.exception.ts`) 계약은 그대로다.
        return await this.fail(
          options,
          run,
          phase,
          new ServiceException(
            'GUIDELINE_SOURCE_UNAVAILABLE',
            undefined,
            acquired.error ?? undefined,
          ),
        );
      }

      const acquireStage = {
        bytes: acquired.body?.length ?? 0,
        contentType: acquired.contentType,
        ms: acquireMs,
      };

      // 첨부가 없는 문서는 에러가 아니다 (§18·§21) — SKIPPED로 종결한다
      if (acquired.status === 'SKIPPED_NO_ATTACHMENT' || !acquired.body) {
        this.metrics.recordPipelineStage('acquire', 'skipped', acquireMs / 1000);
        return {
          run: await this.finish(options, run, {
            status: 'SKIPPED',
            phase,
            stages: { acquire: acquireStage },
          }),
        };
      }
      const body = acquired.body;
      this.metrics.recordPipelineStage('acquire', 'success', acquireMs / 1000);

      // ── PARSE 진입 (acquire 산출을 싣는다) ─────────────────
      phase = 'PARSE';
      run = await this.advance(options, run, phase, { acquire: acquireStage });

      const parseStart = Date.now();
      // PDF 텍스트 추출도 PARSE 단계다 — stages.parse.pages가 그 산출이다
      const pages = await this.pdfExtractor.extractPages(body);

      // 권고 마커를 쓰지 않는 문서는 에러가 아니다 — 인제스트 대상이 아니므로 SKIPPED로 종결한다.
      // NCKM 목록에는 매뉴얼·가이드·권고안·표준 이전 세대 지침이 섞여 있고, §20이 계열 D를
      // "인제스트 대상으로 삼을지부터 판단이 필요하다"며 미룬 판단이 이 자리다
      // (§18이 첨부 없음을 ACQUIRE의 SKIPPED로 뺀 것과 같은 규칙).
      //
      // **판정은 청커 진단이 아니라 필터 이전 원본을 본다.** 진단의 uniqueNumbers가 0이라는 사실은
      // 「문서에 마커가 없다」와 「장·페이지 판정이 마커 페이지를 전량 탈락시켰다」를 구분하지 못한다
      // — 후자는 §20이 계열 B·C에서 겪은 파서 결함 그 자체라, 그것까지 건너뛰면 고쳐야 할 결함이
      // 조용히 묻힌다. 마커가 하나라도 있으면 파싱을 시도하고 실패는 FAILED로 남긴다.
      if (!containsRecommendationMarker(pages)) {
        const skipMs = Date.now() - parseStart;
        this.metrics.recordPipelineStage('parse', 'skipped', skipMs / 1000);
        return {
          run: await this.finish(options, run, {
            status: 'SKIPPED',
            phase,
            // sections·chunks 0은 추측이 아니라 관측이다 — 파서를 부르지 않았고 산출도 없다
            stages: { parse: { pages: pages.length, sections: 0, chunks: 0, ms: skipMs } },
          }),
        };
      }

      const parsed = await this.parseService.parse({
        pages,
        externalId: options.externalId,
        sourceSystem: this.acquisition.sourceSystem,
      });
      const parseMs = Date.now() - parseStart;
      this.metrics.recordPipelineStage('parse', 'success', parseMs / 1000);

      const parseStage = {
        pages: pages.length,
        sections: parsed.sections.length,
        // dedupe **전** 파서 출력 그대로다
        chunks: parsed.sections.reduce((sum, section) => sum + section.chunks.length, 0),
        ms: parseMs,
      };

      // ── EMBED 진입 (parse 산출을 싣는다) ───────────────────
      phase = 'EMBED';
      run = await this.advance(options, run, phase, { parse: parseStage });

      const embedStart = Date.now();
      const outcome = await this.ingestService.embed(parsed);
      const embedMs = Date.now() - embedStart;

      // 재적재 skip은 임베딩을 호출하지 않았으므로 **embed 키 자체를 만들지 않는다**
      const embedStage: PipelineRunStages =
        outcome.kind === 'write'
          ? { embed: { vectors: outcome.embed.vectors, model: outcome.embed.model, ms: embedMs } }
          : {};
      if (outcome.kind === 'write') {
        this.metrics.recordPipelineStage('embed', 'success', embedMs / 1000);
      }

      // ── INGEST 진입 ───────────────────────────────────────
      phase = 'INGEST';
      run = await this.advance(options, run, phase, embedStage);

      const ingestStart = Date.now();
      const result = await this.ingestService.persist(outcome);
      const ingestMs = Date.now() - ingestStart;
      this.metrics.recordPipelineStage('ingest', 'success', ingestMs / 1000);

      return {
        run: await this.finish(options, run, {
        status: 'SUCCEEDED',
        phase,
        guidelineId: result.guidelineId,
        guidelineVersionId: result.guidelineVersionId,
        revision: result.revision,
        created: result.created,
        stages: { ingest: { ...result.stats, ms: ingestMs } },
        }),
      };
    } catch (error) {
      this.metrics.recordPipelineStage(phase.toLowerCase(), 'failure', 0);
      // 던져진 예외의 타입이 아니라 **진행 중이던 단계**가 분류 축이다.
      // 이미 ServiceException이면 그 코드를 존중한다 — §20 가드가 data에 문제 번호를 싣는다.
      const failure =
        error instanceof ServiceException
          ? error
          : new ServiceException(PHASE_FAILURE[phase], undefined, String(error).slice(0, 2000));
      return await this.fail(options, run, phase, failure);
    }
  }

  /** 다음 단계로 진입하며 직전 단계의 산출을 싣는다 — 이 갱신이 곧 run.stage 이벤트다 */
  private async advance(
    options: RunPipelineOptions,
    run: PipelineRunRow,
    phase: PipelineRunPhase,
    stages: PipelineRunStages,
  ): Promise<PipelineRunRow> {
    const next = await this.runs.updateStage(run.id, { phase, stages });
    const resolved = next ?? run;
    await options.onStage?.(resolved);
    return resolved;
  }

  private async finish(
    options: RunPipelineOptions,
    run: PipelineRunRow,
    input: Parameters<PipelineRunRepository['finalizeRun']>[1],
  ): Promise<PipelineRunRow> {
    const finished = (await this.runs.finalizeRun(run.id, input)) ?? run;
    await options.onStage?.(finished);
    return finished;
  }

  private async fail(
    options: RunPipelineOptions,
    run: PipelineRunRow,
    phase: PipelineRunPhase,
    failure: ServiceException,
  ): Promise<PipelineRunOutcome> {
    const finished = await this.finish(options, run, {
      status: 'FAILED',
      phase,
      errorCode: failure.code,
      error: failure.message.slice(0, 2000),
    });
    return { run: finished, error: failure };
  }
}
