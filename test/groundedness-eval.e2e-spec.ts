// docs/specs/30 수용 기준 1~6 동결 테스트 — 구현 중 수정 금지
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
import { RetrievalService } from '../src/infrastructure/retrieval/retrieval.service';
import {
  abstainSample,
  answerableSample,
  sectionPathSample,
} from './fixtures/rag-eval/evalset.sample';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { yotongGuideline } from './fixtures/guideline-samples';
import { socialSignUp } from './fixtures/social-auth';
import { bootstrapApp } from './fixtures/app-bootstrap';

const DISTANCE_CUTOFF = 2;
const RERANK_CANDIDATES = 30;
const RERANK_SCORE_CUTOFF = 6;

interface TestRetrievalConfig {
  distanceCutoff: number;
  rerankEnabled: boolean;
  rerankCandidates: number;
  rerankScoreCutoff: number;
}

class RecordingJudge implements GroundednessJudge {
  readonly model = 'fixed-groundedness-judge-test';
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
    });
  }
}

class ThrowingJudge implements GroundednessJudge {
  readonly model = 'throw-groundedness-judge-test';
  readonly calls: JudgeInput[] = [];

  judge(input: JudgeInput): Promise<GroundednessJudgement> {
    this.calls.push({
      question: input.question,
      evidence: input.evidence.map((item) => ({ ...item })),
      answer: input.answer,
    });
    return Promise.reject(new Error('의도된 심판 오류'));
  }
}

class KeepingReranker implements Reranker {
  readonly model = 'keep-reranker-groundedness-test';

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

class ReversingReranker implements Reranker {
  readonly model = 'reverse-reranker-groundedness-test';

  rerank(
    _question: string,
    candidates: RerankCandidate[],
  ): Promise<RerankResult> {
    return Promise.resolve({
      order: candidates.map((candidate) => candidate.chunkId).reverse(),
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
  miscitedExamples: [],
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

/** 라벨 문구와 표 형식에 의존하지 않고, 같은 행에 실린 리포트 객체의 숫자를 확인한다. */
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

describe('spec 30: groundedness 평가', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let basicApp: INestApplication;
  let reverseApp: INestApplication;
  let throwingApp: INestApplication;

  const basicJudge = new RecordingJudge(fixedJudgement);
  const reverseJudge = new RecordingJudge(fixedJudgement);
  const throwingJudge = new ThrowingJudge();
  const keepingReranker = new KeepingReranker();
  const reverseReranker = new ReversingReranker();

  const createApp = async (
    judge: GroundednessJudge,
    reranker: Reranker,
  ): Promise<INestApplication> => {
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

    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);
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

    basicApp = await createApp(basicJudge, keepingReranker);
    reverseApp = await createApp(reverseJudge, reverseReranker);
    throwingApp = await createApp(throwingJudge, keepingReranker);

    // 세 앱은 같은 DB의 합성 코퍼스를 공유한다. 인제스트는 한 번만 한다.
    await basicApp.get(GuidelineIngestService).ingest(yotongGuideline);

    await socialSignUp(basicApp, {
      email: 'groundedness-basic@clinic.kr',
      clinicName: '근거평가기본한의원',
      licenseNumber: 'LIC-3001',
    });
    await socialSignUp(reverseApp, {
      email: 'groundedness-reverse@clinic.kr',
      clinicName: '근거평가역순한의원',
      licenseNumber: 'LIC-3002',
    });
    await socialSignUp(throwingApp, {
      email: 'groundedness-failure@clinic.kr',
      clinicName: '근거평가실패한의원',
      licenseNumber: 'LIC-3003',
    });
  });

  afterAll(async () => {
    await throwingApp?.close();
    await reverseApp?.close();
    await basicApp?.close();
    await pool?.end();
    await container?.stop();
    await redisContainer?.stop();
  });

  describe('기준 1: answerable 문항만 생성·채점', () => {
    it('기준 1a: answerableCount는 abstain을 제외한 2다', async () => {
      const report = await basicApp
        .get(GroundednessEvalService)
        .evaluate(evaluationItems);

      expect(report.answerableCount).toBe(2);
    });

    it('기준 1b: 심판은 answerable 질문으로만 정확히 2회 호출된다', async () => {
      const callsBefore = basicJudge.calls.length;

      await basicApp.get(GroundednessEvalService).evaluate(evaluationItems);

      const calls = basicJudge.calls.slice(callsBefore);
      expect(calls).toHaveLength(2);
      expect(calls.map((call) => call.question).sort()).toEqual(
        answerableItems.map((item) => item.question).sort(),
      );
      expect(calls.map((call) => call.question)).not.toContain(
        abstainSample.question,
      );
    });
  });

  describe('기준 2: 생성은 리랭크 경로 사용', () => {
    it('기준 2: 심판은 코사인 순서를 뒤집은 상위 5개 근거를 순번 마커와 함께 받는다', async () => {
      const cosineResults = await reverseApp
        .get(RetrievalService)
        .search(answerableSample.question, undefined, RERANK_CANDIDATES);
      expect(cosineResults.length).toBeGreaterThan(1);

      const expectedEvidence = [...cosineResults]
        .reverse()
        .slice(0, 5)
        .map((row, index) => ({
          marker: index + 1,
          content: row.chunk.content,
          guidelineTitle: yotongGuideline.title,
        }));
      const callsBefore = reverseJudge.calls.length;

      await reverseApp.get(GroundednessEvalService).evaluate(evaluationItems);

      const judgedCall = reverseJudge.calls
        .slice(callsBefore)
        .find((call) => call.question === answerableSample.question);
      if (!judgedCall) {
        throw new Error('answerableSample에 대한 심판 호출이 없습니다.');
      }
      expect(judgedCall.evidence).toEqual(expectedEvidence);
    });
  });

  describe('기준 3: 심판 집계 결정성', () => {
    it('기준 3: 같은 평가셋을 두 번 실행하면 verdict와 주장 단위 집계가 같다', async () => {
      const service = basicApp.get(GroundednessEvalService);

      const first = await service.evaluate(evaluationItems);
      const second = await service.evaluate(evaluationItems);

      expect(second.verdicts).toEqual(first.verdicts);
      expect(second.claims).toEqual(first.claims);
      expect(second.verdicts).toEqual({
        grounded: first.verdicts.grounded,
        partial: first.verdicts.partial,
        ungrounded: first.verdicts.ungrounded,
      });
      expect(second.claims).toEqual({
        total: first.claims.total,
        supported: first.claims.supported,
        miscited: first.claims.miscited,
        unsupported: first.claims.unsupported,
      });
    });
  });

  describe('기준 4: 리포트의 verdict 분포와 주장 단위 3축', () => {
    it('기준 4a: grounded·partial·ungrounded 라벨에 각각 집계값을 싣는다', async () => {
      const report = await basicApp
        .get(GroundednessEvalService)
        .evaluate(evaluationItems);
      const markdown = renderGroundednessReport(report);

      expectLabeledValue(
        markdown,
        [/\bgrounded\b/i, /근거\s*(?:충실|있음|충족)/],
        report.verdicts.grounded,
      );
      expectLabeledValue(
        markdown,
        [/\bpartial\b/i, /부분(?:\s*근거)?/],
        report.verdicts.partial,
      );
      expectLabeledValue(
        markdown,
        [/\bungrounded\b/i, /무근거/, /근거\s*(?:없음|불충족)/],
        report.verdicts.ungrounded,
      );
    });

    it('기준 4b: 전체 주장·supported·miscited·unsupported 라벨에 각각 집계값을 싣는다', async () => {
      const report = await basicApp
        .get(GroundednessEvalService)
        .evaluate(evaluationItems);
      const markdown = renderGroundednessReport(report);

      expectLabeledValue(
        markdown,
        [/\bclaims?\b/i, /\btotal\b/i, /(?:총|전체)\s*주장/, /주장\s*(?:수|합계|총계)/],
        report.claims.total,
      );
      expectLabeledValue(
        markdown,
        [/\bsupported\b/i, /지지(?:됨|된)?/, /근거\s*(?:지원|뒷받침)/],
        report.claims.supported,
      );
      expectLabeledValue(
        markdown,
        [/\bmiscited\b/i, /오인용/, /잘못(?:된)?\s*인용/],
        report.claims.miscited,
      );
      expectLabeledValue(
        markdown,
        [/\bunsupported\b/i, /무근거/, /미지원/, /근거\s*없(?:음|는)/],
        report.claims.unsupported,
      );
    });
  });

  describe('기준 5: 리포트의 기계 검사', () => {
    it('기준 5: 마크다운 위반 수와 마커 미사용 답변 수를 리포트 객체의 값대로 싣는다', async () => {
      const report = await basicApp
        .get(GroundednessEvalService)
        .evaluate(evaluationItems);
      const markdown = renderGroundednessReport(report);

      expectLabeledValue(
        markdown,
        [/markdown\s*violations?/i, /마크다운\s*위반/],
        report.mechanical.markdownViolations,
      );
      expectLabeledValue(
        markdown,
        [/no\s*marker\s*answers?/i, /noMarkerAnswers/i, /마커\s*(?:미사용|없음)/],
        report.mechanical.noMarkerAnswers,
      );
    });
  });

  describe('기준 6: 생성·채점 실패 문항 수집', () => {
    it('기준 6a: 심판 오류를 두 answerable 문항의 itemId·stage·reason과 함께 모은다', async () => {
      const report = await throwingApp
        .get(GroundednessEvalService)
        .evaluate(evaluationItems);

      expect(report.failures).toHaveLength(2);
      expect(report.failures.map((failure) => failure.itemId).sort()).toEqual(
        answerableItems.map((item) => item.id).sort(),
      );
      for (const failure of report.failures) {
        expect(failure).toEqual(
          expect.objectContaining({
            itemId: expect.any(String),
            stage: 'judge',
            reason: expect.any(String),
          }),
        );
        expect(failure.reason.length).toBeGreaterThan(0);
      }
    });

    it('기준 6b: 심판 오류가 나도 evaluate는 예외 대신 부분 리포트를 반환한다', async () => {
      await expect(
        throwingApp.get(GroundednessEvalService).evaluate(evaluationItems),
      ).resolves.toEqual(
        expect.objectContaining({
          failures: expect.any(Array),
        }),
      );
    });

    it('기준 6c: 실패한 두 문항의 itemId를 리포트 마크다운에 나열한다', async () => {
      const report = await throwingApp
        .get(GroundednessEvalService)
        .evaluate(evaluationItems);
      const markdown = renderGroundednessReport(report);

      expect(markdown).toContain(answerableSample.id);
      expect(markdown).toContain(sectionPathSample.id);
    });
  });
});
