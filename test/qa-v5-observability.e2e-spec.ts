// docs/specs/32 수용 기준 6~7 동결 테스트 — 구현 중 수정 금지
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import cookieParser from 'cookie-parser';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { EvaluationModule } from '../src/domain/evaluation/evaluation.module';
import type { EvalSetItem } from '../src/domain/evaluation/evalset.types';
import { GroundednessEvalService } from '../src/domain/evaluation/groundedness-eval.service';
import {
  GROUNDEDNESS_JUDGE,
  GroundednessJudge,
  GroundednessJudgement,
  JudgeInput,
} from '../src/domain/evaluation/groundedness-judge.port';
import { renderGroundednessReport } from '../src/domain/evaluation/groundedness.report';
import { GuidelineIngestService } from '../src/domain/guideline/service/guideline-ingest.service';
import { retrievalConfig } from '../src/global/config/retrieval.config';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import {
  RERANKER,
  RerankCandidate,
  Reranker,
  RerankResult,
} from '../src/infrastructure/retrieval/reranker.port';
import { bootstrapApp } from './fixtures/app-bootstrap';
import {
  abstainSample,
  answerableSample,
  sectionPathSample,
} from './fixtures/rag-eval/evalset.sample';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { yotongGuideline } from './fixtures/guideline-samples';
import { socialSignUp } from './fixtures/social-auth';

const DISTANCE_CUTOFF = 2;
const RERANK_CANDIDATES = 30;
const RERANK_SCORE_CUTOFF = 6;
const MISCITED_EXAMPLE = '침 치료가 양약보다 더 적절하다 [1]';

interface TestRetrievalConfig {
  distanceCutoff: number;
  rerankEnabled: boolean;
  rerankCandidates: number;
  rerankScoreCutoff: number;
}

class RecordingJudge implements GroundednessJudge {
  readonly model = 'qa-v5-observability-judge-test';
  readonly calls: JudgeInput[] = [];

  constructor(private readonly judgement: GroundednessJudgement) {}

  judge(input: JudgeInput): Promise<GroundednessJudgement> {
    this.calls.push({
      question: input.question,
      evidence: input.evidence.map((item) => ({ ...item })),
      answer: input.answer,
    });

    return Promise.resolve({
      ...this.judgement,
      unsupportedExamples: [...this.judgement.unsupportedExamples],
      miscitedExamples: [...this.judgement.miscitedExamples],
    });
  }
}

class KeepingReranker implements Reranker {
  readonly model = 'keep-reranker-qa-v5-observability-test';

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

const fixedJudgement: GroundednessJudgement = {
  claims: 4,
  supported: 2,
  miscited: 1,
  unsupported: 1,
  unsupportedExamples: ['근거가 없는 합성 주장'],
  miscitedExamples: [MISCITED_EXAMPLE],
  insufficiencyDisclosed: true,
  verdict: 'partial',
};

const evaluationItems: EvalSetItem[] = [
  answerableSample,
  sectionPathSample,
  abstainSample,
];

const answerableItems = [answerableSample, sectionPathSample];

const enabledConfig: TestRetrievalConfig = {
  distanceCutoff: DISTANCE_CUTOFF,
  rerankEnabled: true,
  rerankCandidates: RERANK_CANDIDATES,
  rerankScoreCutoff: RERANK_SCORE_CUTOFF,
};

/** 라벨이 있는 줄에 리포트 객체와 같은 숫자가 렌더됐는지 확인한다. */
function expectLabeledValue(
  markdown: string,
  labelPatterns: RegExp[],
  expected: number,
): void {
  const labeledLines = markdown
    .split('\n')
    .filter((line) => labelPatterns.some((pattern) => pattern.test(line)));

  expect(labeledLines.length).toBeGreaterThan(0);

  const renderedNumbers = labeledLines.flatMap((line) =>
    [...line.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0])),
  );
  expect(renderedNumbers).toContain(expected);
}

describe('spec 32: qa-v5 groundedness 관측성', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let app: INestApplication;

  const judge = new RecordingJudge(fixedJudgement);
  const reranker = new KeepingReranker();

  const createApp = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, EvaluationModule],
    })
      .overrideProvider(OAuthProviderRegistry)
      .useClass(FakeOAuthProviderRegistry)
      .overrideProvider(GROUNDEDNESS_JUDGE)
      .useValue(judge)
      .overrideProvider(RERANKER)
      .useValue(reranker)
      .overrideProvider(retrievalConfig.KEY)
      .useValue(enabledConfig)
      .compile();

    const createdApp = moduleRef.createNestApplication();
    createdApp.setGlobalPrefix('api/v1');
    createdApp.use(cookieParser());
    await bootstrapApp(createdApp);
    return createdApp;
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

    app = await createApp();
    await app.get(GuidelineIngestService).ingest(yotongGuideline);
    await socialSignUp(app, {
      email: 'qa-v5-observability@clinic.kr',
      clinicName: 'qa-v5관측성한의원',
      licenseNumber: 'LIC-3201',
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  it('기준 6a: miscited 주장 원문 예시를 해당 FlaggedAnswer에 전파한다', async () => {
    const report = await app
      .get(GroundednessEvalService)
      .evaluate(evaluationItems);
    const flagged = report.flagged.find(
      (item) => item.itemId === answerableSample.id,
    );

    expect(flagged).toBeDefined();
    expect(flagged?.miscitedExamples).toEqual([MISCITED_EXAMPLE]);
  });

  it('기준 6b: 결함 문항 표의 해당 itemId 행에 miscited 원문을 싣는다', async () => {
    const report = await app
      .get(GroundednessEvalService)
      .evaluate(evaluationItems);
    const markdown = renderGroundednessReport(report);
    const flaggedRow = markdown
      .split('\n')
      .find((line) => line.startsWith(`| ${answerableSample.id} |`));

    expect(flaggedRow).toBeDefined();
    expect(flaggedRow).toContain(MISCITED_EXAMPLE);
  });

  it('기준 7a: 문항당 평균 주장 수를 채점 성공 문항 수로 계산해 라벨과 값으로 싣는다', async () => {
    const report = await app
      .get(GroundednessEvalService)
      .evaluate(evaluationItems);
    const markdown = renderGroundednessReport(report);
    const expectedClaims = fixedJudgement.claims * answerableItems.length;
    const expectedJudgedCount = answerableItems.length;
    const expectedAverage =
      Math.round((expectedClaims / expectedJudgedCount) * 10) / 10;

    expect(report.suppressionGuard.avgClaimsPerAnswer).toBe(expectedAverage);
    expectLabeledValue(
      markdown,
      [/avgClaimsPerAnswer/i, /문항당\s*평균\s*주장\s*수/, /평균\s*주장\s*수/],
      report.suppressionGuard.avgClaimsPerAnswer,
    );
  });

  it('기준 7b: 평균 답변 길이를 생성 성공 문항 수로 계산해 라벨과 값으로 싣는다', async () => {
    const callsBefore = judge.calls.length;
    const report = await app
      .get(GroundednessEvalService)
      .evaluate(evaluationItems);
    const calls = judge.calls.slice(callsBefore);
    const markdown = renderGroundednessReport(report);
    const expectedAverage = Math.round(
      calls.reduce((sum, call) => sum + call.answer.length, 0) /
        answerableItems.length,
    );

    expect(calls).toHaveLength(answerableItems.length);
    expect(report.suppressionGuard.avgAnswerLengthChars).toBe(expectedAverage);
    expect(report.suppressionGuard.avgAnswerLengthChars).toBeGreaterThan(0);
    expectLabeledValue(
      markdown,
      [/avgAnswerLengthChars/i, /평균\s*답변\s*길이(?:\s*\(문자\))?/],
      report.suppressionGuard.avgAnswerLengthChars,
    );
  });

  it('기준 7c: 근거 부족 고지 답변 수를 채점 성공 문항 수로 집계해 라벨과 값으로 싣는다', async () => {
    const report = await app
      .get(GroundednessEvalService)
      .evaluate(evaluationItems);
    const markdown = renderGroundednessReport(report);
    const expectedCount = answerableItems.length;

    expect(report.suppressionGuard.insufficiencyDisclosedCount).toBe(
      expectedCount,
    );
    expectLabeledValue(
      markdown,
      [
        /insufficiencyDisclosedCount/i,
        /근거\s*부족\s*고지\s*답변\s*수/,
        /근거\s*부족\s*고지/,
      ],
      report.suppressionGuard.insufficiencyDisclosedCount,
    );
  });
});
