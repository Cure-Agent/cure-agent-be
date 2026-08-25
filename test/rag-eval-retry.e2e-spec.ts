// 이슈 #352 수용 기준 동결 테스트 — 구현 중 수정 금지
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import {
  GENERATION_RETRY_DELAYS_MS,
  RERANK_RETRY_DELAYS_MS,
} from '../src/domain/evaluation/eval-retry';
import { EvaluationModule } from '../src/domain/evaluation/evaluation.module';
import { type EvalSetItem } from '../src/domain/evaluation/evalset.types';
import {
  type GateBreakdown,
  type GenerationVerdictRecord,
  type RagEvalReport,
  RagEvalService,
} from '../src/domain/evaluation/rag-eval.service';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { retrievalConfig } from '../src/global/config/retrieval.config';
import {
  LLM_PROVIDERS,
  type LlmAnswerChunk,
  type LlmEvidenceContext,
  type LlmProvider,
  LlmProviderError,
  type LlmStreamRequest,
} from '../src/infrastructure/llm/llm-provider.port';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import { RerankerError } from '../src/infrastructure/retrieval/openai-reranker';
import {
  RERANKER,
  type RerankCandidate,
  type Reranker,
  type RerankResult,
} from '../src/infrastructure/retrieval/reranker.port';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { yotongGuideline } from './fixtures/guideline-samples';
import {
  abstainSample,
  answerableSample,
  sectionPathSample,
} from './fixtures/rag-eval/evalset.sample';

const LARGE_DISTANCE_CUTOFF = 2;
const CONFIGURED_SCORE_CUTOFF = 6;
const RERANK_CANDIDATES = 30;
const SUCCESS_RELEVANCE = 8.75;
const FAST_RETRY_DELAY_MS = 1;
const RATE_LIMIT_RETRY_AFTER_SEC = 0.0001;
const RERANK_RATE_LIMIT_MESSAGE = '이슈 352 리랭크 429';
const RERANK_FAILURE_MESSAGE = '이슈 352 리랭크 영구 실패';
const GENERATION_RATE_LIMIT_MESSAGE = '이슈 352 생성 429';
const SWEEP_CUTOFFS = Array.from({ length: 11 }, (_, cutoff) => cutoff);

interface TestRetrievalConfig {
  distanceCutoff: number;
  rerankEnabled: boolean;
  rerankCandidates: number;
  rerankScoreCutoff: number;
  hybridEnabled: boolean;
}

interface RecordedGenerationCall {
  question: string;
  evidence: LlmEvidenceContext[];
}

interface RecordedRerankCall {
  question: string;
  candidates: RerankCandidate[];
}

type RerankerMode =
  | 'success'
  | 'fail_first_rate_limit'
  | 'always_rate_limit'
  | 'always_non_rate_limit';

type ProviderMode =
  | 'success'
  | 'fail_first_rate_limit'
  | 'always_rate_limit';

const evaluationItems: EvalSetItem[] = [
  answerableSample,
  sectionPathSample,
  abstainSample,
];

const passConfig: TestRetrievalConfig = {
  distanceCutoff: LARGE_DISTANCE_CUTOFF,
  rerankEnabled: true,
  rerankCandidates: RERANK_CANDIDATES,
  rerankScoreCutoff: CONFIGURED_SCORE_CUTOFF,
  hybridEnabled: false,
};

class StatefulReranker implements Reranker {
  readonly model = 'rag-eval-retry-reranker';
  readonly calls: RecordedRerankCall[] = [];
  private mode: RerankerMode = 'success';

  configure(mode: RerankerMode): void {
    this.mode = mode;
    this.calls.length = 0;
  }

  rerank(
    question: string,
    candidates: RerankCandidate[],
  ): Promise<RerankResult> {
    this.calls.push({
      question,
      candidates: candidates.map((candidate) => ({ ...candidate })),
    });

    if (
      this.mode === 'always_rate_limit' ||
      (this.mode === 'fail_first_rate_limit' && this.calls.length === 1)
    ) {
      return Promise.reject(
        new RerankerError(RERANK_RATE_LIMIT_MESSAGE, {
          rateLimited: true,
        }),
      );
    }

    if (this.mode === 'always_non_rate_limit') {
      return Promise.reject(new RerankerError(RERANK_FAILURE_MESSAGE));
    }

    return Promise.resolve({
      order: candidates.map((candidate) => candidate.chunkId),
      top1Relevance: SUCCESS_RELEVANCE,
    });
  }
}

class StatefulProvider implements LlmProvider {
  readonly name = 'rag-eval-retry-provider';
  readonly model = 'rag-eval-retry-model';
  readonly calls: RecordedGenerationCall[] = [];
  private mode: ProviderMode = 'success';

  configure(mode: ProviderMode): void {
    this.mode = mode;
    this.calls.length = 0;
  }

  async *streamAnswer(
    request: LlmStreamRequest,
  ): AsyncIterable<LlmAnswerChunk> {
    this.calls.push({
      question: request.question,
      evidence: request.evidence.map((evidence) => ({
        ...evidence,
        sectionPath: [...evidence.sectionPath],
      })),
    });

    if (
      this.mode === 'always_rate_limit' ||
      (this.mode === 'fail_first_rate_limit' && this.calls.length === 1)
    ) {
      throw new LlmProviderError(GENERATION_RATE_LIMIT_MESSAGE, {
        rateLimited: true,
        retryAfterSec: RATE_LIMIT_RETRY_AFTER_SEC,
      });
    }

    yield {
      kind: 'verdict',
      insufficientEvidence: false,
      missingAspects: [],
    };
    yield { kind: 'delta', text: '재시도 뒤 정상 생성된 답변입니다 [1].' };
  }
}

function overwriteSchedule(
  schedule: readonly number[],
  replacement: readonly number[],
): void {
  const mutableSchedule = schedule as number[];
  mutableSchedule.splice(0, mutableSchedule.length, ...replacement);
}

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

function verdictOf(
  report: RagEvalReport,
  itemId: string,
): GenerationVerdictRecord {
  const verdict = report.generationVerdicts.find(
    (candidate) => candidate.itemId === itemId,
  );
  if (!verdict) throw new Error(`${itemId} 생성 판정 기록이 없습니다.`);
  return verdict;
}

function breakdownTotal(breakdown: GateBreakdown): number {
  return (
    breakdown.retrievalGate +
    breakdown.generationGate +
    breakdown.answered +
    breakdown.generationFailed
  );
}

function expectCompleteSweep(report: RagEvalReport): void {
  expect(report.cutSweep).toHaveLength(SWEEP_CUTOFFS.length);
  expect(report.cutSweep.map((row) => row.cutoff)).toEqual(SWEEP_CUTOFFS);
}

jest.setTimeout(180_000);

describe('이슈 #352: RAG 오프라인 평가 429 재시도', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;
  let service: RagEvalService;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalRerankDelays = [...RERANK_RETRY_DELAYS_MS];
  const originalGenerationDelays = [...GENERATION_RETRY_DELAYS_MS];

  const reranker = new StatefulReranker();
  const provider = new StatefulProvider();

  beforeAll(async () => {
    // 지연 값 자체는 유닛 테스트가 동결한다. e2e는 같은 재시도 횟수만 1ms 간격으로 관측한다.
    overwriteSchedule(
      RERANK_RETRY_DELAYS_MS,
      RERANK_RETRY_DELAYS_MS.map(() => FAST_RETRY_DELAY_MS),
    );
    overwriteSchedule(
      GENERATION_RETRY_DELAYS_MS,
      GENERATION_RETRY_DELAYS_MS.map(() => FAST_RETRY_DELAY_MS),
    );

    [postgresContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = postgresContainer.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();
    process.env.OPENAI_API_KEY = '';

    pool = new Pool({ connectionString: postgresContainer.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, EvaluationModule],
    })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(LLM_PROVIDERS)
      .useValue([provider])
      .overrideProvider(RERANKER)
      .useValue(reranker)
      .overrideProvider(retrievalConfig.KEY)
      .useValue(passConfig)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);

    await app.get(GuidelineIngestService).ingest(yotongGuideline);
    service = app.get(RagEvalService);
  });

  afterAll(async () => {
    overwriteSchedule(RERANK_RETRY_DELAYS_MS, originalRerankDelays);
    overwriteSchedule(GENERATION_RETRY_DELAYS_MS, originalGenerationDelays);

    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('REDIS_URL', originalRedisUrl);
    restoreEnv('OPENAI_API_KEY', originalOpenAiApiKey);

    await app?.close();
    await pool?.end();
    await Promise.all([
      postgresContainer?.stop(),
      redisContainer?.stop(),
    ]);
  });

  it('기준 D1: 리랭커가 429 한 번 뒤 성공하면 evaluate는 리포트를 반환한다', async () => {
    reranker.configure('fail_first_rate_limit');
    provider.configure('success');

    await expect(service.evaluate(evaluationItems)).resolves.toEqual(
      expect.objectContaining({
        answerableCount: 2,
        abstainCount: 1,
        cutSweep: expect.any(Array),
      }),
    );
  });

  it('기준 D2: 429 한 번 뒤 성공한 실행은 문항 수보다 많은 리랭커 호출을 남긴다', async () => {
    reranker.configure('fail_first_rate_limit');
    provider.configure('success');

    await service.evaluate(evaluationItems);

    expect(reranker.calls.length).toBeGreaterThan(evaluationItems.length);
  });

  it('기준 D3: 429 뒤 성공한 문항에는 성공 시도의 리랭크 점수가 실린다', async () => {
    reranker.configure('fail_first_rate_limit');
    provider.configure('success');

    const report = await service.evaluate(evaluationItems);

    expect(verdictOf(report, answerableSample.id).top1Relevance).toBe(
      SUCCESS_RELEVANCE,
    );
  });

  it('기준 D4: 리랭커 429 재시도를 소진해도 evaluate는 리포트를 반환한다', async () => {
    reranker.configure('always_rate_limit');
    provider.configure('success');

    await expect(service.evaluate(evaluationItems)).resolves.toEqual(
      expect.objectContaining({
        answerableCount: 2,
        abstainCount: 1,
        cutSweep: expect.any(Array),
      }),
    );
  });

  it('기준 D5: 리랭크 재시도 소진 실행도 컷 0~10의 열한 행을 만든다', async () => {
    reranker.configure('always_rate_limit');
    provider.configure('success');

    const report = await service.evaluate(evaluationItems);

    expectCompleteSweep(report);
  });

  it('기준 D6: 리랭크 재시도 소진 실행도 각 컷의 네 갈래 합을 보존한다', async () => {
    reranker.configure('always_rate_limit');
    provider.configure('success');

    const report = await service.evaluate(evaluationItems);

    expectCompleteSweep(report);
    for (const row of report.cutSweep) {
      expect(breakdownTotal(row.answerable)).toBe(report.answerableCount);
      expect(breakdownTotal(row.abstain)).toBe(report.abstainCount);
    }
  });

  it('기준 D7: 끝내 리랭크하지 못한 문항은 retrievalGate로 세지 않는다', async () => {
    reranker.configure('always_rate_limit');
    provider.configure('success');

    const report = await service.evaluate(evaluationItems);

    expectCompleteSweep(report);
    for (const row of report.cutSweep) {
      expect(row.answerable.retrievalGate).toBe(0);
      expect(row.abstain.retrievalGate).toBe(0);
    }
  });

  it('기준 D8: 끝내 리랭크하지 못한 문항은 전 컷에서 같은 실패 갈래에 머문다', async () => {
    reranker.configure('always_rate_limit');
    provider.configure('success');

    const report = await service.evaluate(evaluationItems);

    expectCompleteSweep(report);
    const first = report.cutSweep[0];
    expect(first.answerable).toMatchObject({
      retrievalGate: 0,
      generationGate: 0,
      answered: 0,
      generationFailed: report.answerableCount,
    });
    expect(first.abstain).toMatchObject({
      retrievalGate: 0,
      generationGate: 0,
      answered: 0,
      generationFailed: report.abstainCount,
    });
    for (const row of report.cutSweep) {
      expect(row.answerable).toEqual(first.answerable);
      expect(row.abstain).toEqual(first.abstain);
    }
  });

  it('기준 D9: 한도 초과가 아닌 리랭커 오류는 문항마다 한 번만 시도한다', async () => {
    reranker.configure('always_non_rate_limit');
    provider.configure('success');

    await service.evaluate(evaluationItems);

    expect(reranker.calls).toHaveLength(evaluationItems.length);
  });

  it("기준 D10: 생성 소진 한 번 뒤 성공하면 그 문항 status는 'failed'가 아니다", async () => {
    reranker.configure('success');
    provider.configure('fail_first_rate_limit');

    const report = await service.evaluate(evaluationItems);

    expect(verdictOf(report, answerableSample.id).status).not.toBe('failed');
    expect(provider.calls.length).toBeGreaterThan(evaluationItems.length);
  });

  it("기준 D11: 생성 소진이 계속되면 status는 'failed'지만 evaluate는 리포트를 반환한다", async () => {
    reranker.configure('success');
    provider.configure('always_rate_limit');

    const reportPromise = service.evaluate(evaluationItems);
    await expect(reportPromise).resolves.toEqual(
      expect.objectContaining({
        generationMeasured: true,
        cutSweep: expect.any(Array),
      }),
    );
    const report = await reportPromise;

    expect(verdictOf(report, answerableSample.id).status).toBe('failed');
    expect(provider.calls.length).toBeGreaterThan(evaluationItems.length);
  });
});
