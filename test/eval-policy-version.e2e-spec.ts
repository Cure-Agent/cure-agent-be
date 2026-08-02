// docs/specs/27 기준 5e(개정) 동결 테스트 — 구현 중 수정 금지
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { EvaluationModule } from '../src/domain/evaluation/evaluation.module';
import type { EvalSetItem } from '../src/domain/evaluation/evalset.types';
import { renderEvalReport } from '../src/domain/evaluation/rag-eval.report';
import { RagEvalService } from '../src/domain/evaluation/rag-eval.service';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { retrievalConfig } from '../src/global/config/retrieval.config';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import {
  RERANKER,
  RerankCandidate,
  Reranker,
  RerankResult,
} from '../src/infrastructure/retrieval/reranker.port';
import {
  abstainSample,
  answerableSample,
  sectionPathSample,
} from './fixtures/rag-eval/evalset.sample';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { yotongGuideline } from './fixtures/guideline-samples';

const DISTANCE_CUTOFF = 2;
const RERANK_CANDIDATES = 30;
const RERANK_SCORE_CUTOFF = 9;
const HYBRID_V4_POLICY_VERSION =
  'hybrid-rrf60-top30x2-cut2-v4/fake-embedding-v1';
const VECTOR_V2_POLICY_VERSION =
  'cosine-top5-cut2-v2/fake-embedding-v1';

interface TestRetrievalConfig {
  distanceCutoff: number;
  rerankEnabled: boolean;
  rerankCandidates: number;
  rerankScoreCutoff: number;
  hybridEnabled: boolean;
}

class KeepingReranker implements Reranker {
  readonly model = 'eval-policy-version-test';

  rerank(
    _question: string,
    candidates: RerankCandidate[],
  ): Promise<RerankResult> {
    return Promise.resolve({
      order: candidates.map((candidate) => candidate.chunkId),
      top1Relevance: 10,
    });
  }
}

const evaluationItems: EvalSetItem[] = [
  answerableSample,
  sectionPathSample,
  abstainSample,
];

describe('issue #246: eval 리포트 검색 정책 버전', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let hybridApp: INestApplication;
  let vectorApp: INestApplication;

  const createApp = async (
    hybridEnabled: boolean,
  ): Promise<INestApplication> => {
    const config: TestRetrievalConfig = {
      distanceCutoff: DISTANCE_CUTOFF,
      rerankEnabled: true,
      rerankCandidates: RERANK_CANDIDATES,
      rerankScoreCutoff: RERANK_SCORE_CUTOFF,
      hybridEnabled,
    };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, EvaluationModule],
    })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(RERANKER)
      .useValue(new KeepingReranker())
      .overrideProvider(retrievalConfig.KEY)
      .useValue(config)
      .compile();

    const app = moduleRef.createNestApplication();
    await app.init();
    return app;
  };

  beforeAll(async () => {
    [container, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    hybridApp = await createApp(true);
    vectorApp = await createApp(false);

    // 두 모드가 같은 코퍼스를 평가하도록 한 번만 인제스트한다.
    await hybridApp.get(GuidelineIngestService).ingest(yotongGuideline);
  });

  afterAll(async () => {
    await vectorApp?.close();
    await hybridApp?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  it('하이브리드가 켜지면 리포트와 마크다운에 하이브리드 v4 정책 문자열을 싣는다', async () => {
    const report = await hybridApp
      .get(RagEvalService)
      .evaluate(evaluationItems);
    const markdown = renderEvalReport(report);

    expect(report.retrievalPolicyVersion).toBe(HYBRID_V4_POLICY_VERSION);
    expect(report.retrievalPolicyVersion).not.toBe(VECTOR_V2_POLICY_VERSION);
    expect(markdown).toContain('retrievalPolicyVersion');
    expect(markdown).toContain(HYBRID_V4_POLICY_VERSION);
  });

  it('하이브리드가 꺼지면 같은 코퍼스·문항의 리포트에 벡터 전용 v2 정책 문자열을 싣는다', async () => {
    const [vectorReport, hybridReport] = await Promise.all([
      vectorApp.get(RagEvalService).evaluate(evaluationItems),
      hybridApp.get(RagEvalService).evaluate(evaluationItems),
    ]);

    expect(vectorReport.retrievalPolicyVersion).toBe(VECTOR_V2_POLICY_VERSION);
    expect(vectorReport.retrievalPolicyVersion).not.toBe(
      HYBRID_V4_POLICY_VERSION,
    );
    // 대조 모드까지 고정해 현재처럼 두 모드 모두 v2를 내는 구현에서는 이 테스트도 실패한다.
    expect(hybridReport.retrievalPolicyVersion).toBe(
      HYBRID_V4_POLICY_VERSION,
    );
  });

  it('같은 지표라도 하이브리드와 벡터 전용 검색의 정책 문자열은 서로 다르다', async () => {
    const [hybridReport, vectorReport] = await Promise.all([
      hybridApp.get(RagEvalService).evaluate(evaluationItems),
      vectorApp.get(RagEvalService).evaluate(evaluationItems),
    ]);

    expect(hybridReport.retrievalPolicyVersion).toBe(
      HYBRID_V4_POLICY_VERSION,
    );
    expect(vectorReport.retrievalPolicyVersion).toBe(VECTOR_V2_POLICY_VERSION);
    expect(hybridReport.retrievalPolicyVersion).not.toBe(
      vectorReport.retrievalPolicyVersion,
    );
  });
});
