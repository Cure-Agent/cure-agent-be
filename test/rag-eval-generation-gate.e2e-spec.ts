// 이슈 #348 수용 기준 동결 테스트 — 구현 중 수정 금지
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
import { EvaluationModule } from '../src/domain/evaluation/evaluation.module';
import { type EvalSetItem } from '../src/domain/evaluation/evalset.types';
import { renderEvalReport } from '../src/domain/evaluation/rag-eval.report';
import {
  type CutSweepRow,
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
import { PROMPT_VERSION } from '../src/infrastructure/llm/prompt-builder';
import { OAuthProviderRegistry } from '../src/infrastructure/oauth/oauth-provider.registry';
import {
  RERANKER,
  type RerankCandidate,
  type Reranker,
  type RerankResult,
} from '../src/infrastructure/retrieval/reranker.port';
import { RETRIEVAL_TOP_K } from '../src/infrastructure/retrieval/retrieval.service';
import { bootstrapApp } from './fixtures/app-bootstrap';
import { FakeOAuthProviderRegistry } from './fixtures/fake-oauth';
import { yotongGuideline } from './fixtures/guideline-samples';
import {
  abstainSample,
  answerableSample,
  sectionPathSample,
} from './fixtures/rag-eval/evalset.sample';

const LARGE_DISTANCE_CUTOFF = 2;
const SMALL_DISTANCE_CUTOFF = 0.000001;
const CONFIGURED_SCORE_CUTOFF = 6;
const RERANK_CANDIDATES = 30;
const HIGH_RELEVANCE = 10;
const LOW_RELEVANCE = 0;
const MODEL_MISSING_ASPECT = '침 치료 권고의 근거 강도';
const FAILURE_MESSAGE = '이슈 348 생성 평가용 의도된 실패';
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
  top1Relevance: number;
}

type ProviderMode =
  | 'mixed'
  | 'answerable'
  | 'insufficient'
  | 'no_verdict';

type RelevanceSource = number | ((question: string) => number);

const evaluationItems: EvalSetItem[] = [
  answerableSample,
  sectionPathSample,
  abstainSample,
];

const mixedRelevances = new Map<string, number>([
  [answerableSample.question, 2.25],
  [sectionPathSample.question, 7.75],
  [abstainSample.question, 4.5],
]);

const passConfig: TestRetrievalConfig = {
  distanceCutoff: LARGE_DISTANCE_CUTOFF,
  rerankEnabled: true,
  rerankCandidates: RERANK_CANDIDATES,
  rerankScoreCutoff: CONFIGURED_SCORE_CUTOFF,
  hybridEnabled: false,
};

class RecordingProvider implements LlmProvider {
  readonly model: string;
  readonly calls: RecordedGenerationCall[] = [];

  constructor(
    readonly name: string,
    private mode: ProviderMode,
  ) {
    this.model = `${name}-model`;
  }

  setMode(mode: ProviderMode): void {
    this.mode = mode;
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

    if (this.mode === 'mixed') {
      if (request.question === answerableSample.question) {
        yield {
          kind: 'verdict',
          insufficientEvidence: true,
          missingAspects: [MODEL_MISSING_ASPECT],
        };
      } else if (request.question === sectionPathSample.question) {
        yield {
          kind: 'verdict',
          insufficientEvidence: true,
          missingAspects: [],
        };
      } else {
        yield { kind: 'delta', text: '판정 미방출 답변입니다 [1].' };
      }
      return;
    }

    if (this.mode === 'answerable') {
      yield {
        kind: 'verdict',
        insufficientEvidence: false,
        missingAspects: [],
      };
      yield { kind: 'delta', text: '근거로 답할 수 있습니다 [1].' };
      return;
    }

    if (this.mode === 'insufficient') {
      yield {
        kind: 'verdict',
        insufficientEvidence: true,
        missingAspects: [`${request.question}의 누락 축`],
      };
      yield { kind: 'delta', text: '게이트 뒤에 노출되면 안 되는 문장입니다.' };
      return;
    }

    yield { kind: 'delta', text: '판정 없이 정상 답변합니다 [1].' };
  }
}

class AlwaysFailingProvider implements LlmProvider {
  readonly name = 'rag-eval-generation-failing-provider';
  readonly model = 'rag-eval-generation-failing-model';

  async *streamAnswer(
    _request: LlmStreamRequest,
  ): AsyncIterable<LlmAnswerChunk> {
    await Promise.resolve();
    throw new LlmProviderError(FAILURE_MESSAGE);
  }
}

class RecordingReranker implements Reranker {
  readonly calls: RecordedRerankCall[] = [];
  private relevanceOf: (question: string) => number;

  constructor(
    readonly model: string,
    private readonly reverse: boolean,
    relevance: RelevanceSource,
  ) {
    this.relevanceOf =
      typeof relevance === 'number' ? () => relevance : relevance;
  }

  setRelevance(relevance: RelevanceSource): void {
    this.relevanceOf =
      typeof relevance === 'number' ? () => relevance : relevance;
  }

  rerank(
    question: string,
    candidates: RerankCandidate[],
  ): Promise<RerankResult> {
    const top1Relevance = this.relevanceOf(question);
    const copiedCandidates = candidates.map((candidate) => ({ ...candidate }));
    this.calls.push({
      question,
      candidates: copiedCandidates,
      top1Relevance,
    });

    const ordered = this.reverse
      ? [...candidates].reverse()
      : candidates;
    return Promise.resolve({
      order: ordered.map((candidate) => candidate.chunkId),
      top1Relevance,
    });
  }
}

function mixedRelevanceOf(question: string): number {
  const relevance = mixedRelevances.get(question);
  if (relevance === undefined) {
    throw new Error(`혼합 점수가 정의되지 않은 문항입니다: ${question}`);
  }
  return relevance;
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

function generationCallOf(
  calls: RecordedGenerationCall[],
  question: string,
): RecordedGenerationCall {
  const call = calls.find((candidate) => candidate.question === question);
  if (!call) throw new Error(`${question} 생성 호출 기록이 없습니다.`);
  return call;
}

function rerankCallOf(
  calls: RecordedRerankCall[],
  question: string,
): RecordedRerankCall {
  const call = calls.find((candidate) => candidate.question === question);
  if (!call) throw new Error(`${question} 리랭크 호출 기록이 없습니다.`);
  return call;
}

function sweepRowOf(report: RagEvalReport, cutoff: number): CutSweepRow {
  const row = report.cutSweep.find((candidate) => candidate.cutoff === cutoff);
  if (!row) throw new Error(`컷 ${cutoff} 스윕 행이 없습니다.`);
  return row;
}

function breakdownTotal(breakdown: GateBreakdown): number {
  return (
    breakdown.retrievalGate +
    breakdown.generationGate +
    breakdown.answered +
    breakdown.generationFailed
  );
}

function retrievalGateTotal(row: CutSweepRow): number {
  return row.answerable.retrievalGate + row.abstain.retrievalGate;
}

function expectCompleteSweep(report: RagEvalReport): void {
  expect(report.cutSweep).toHaveLength(SWEEP_CUTOFFS.length);
  expect(report.cutSweep.map((row) => row.cutoff)).toEqual(SWEEP_CUTOFFS);
}

function searchMetricsOf(report: RagEvalReport): Record<string, number> {
  return {
    recallAt5: report.recallAt5,
    mrrAt5: report.mrrAt5,
    recallAt30: report.recallAt30,
    rerankedRecallAt5: report.rerankedRecallAt5,
    rerankedMrrAt5: report.rerankedMrrAt5,
  };
}

function abstainMetricsOf(report: RagEvalReport): Record<string, number> {
  return {
    abstainRecall: report.abstainRecall,
    overAbstainRate: report.overAbstainRate,
    rerankedAbstainRecall: report.rerankedAbstainRecall,
    rerankedOverAbstainRate: report.rerankedOverAbstainRate,
  };
}

function integerValuesIn(line: string): number[] {
  return [...line.matchAll(/(?<![\d.])-?\d+(?![\d.])/g)].map((match) =>
    Number(match[0]),
  );
}

function renderedSweepValues(row: CutSweepRow): number[] {
  return [
    row.cutoff,
    row.answerable.retrievalGate,
    row.answerable.generationGate,
    row.answerable.answered,
    row.answerable.generationFailed,
    row.abstain.retrievalGate,
    row.abstain.generationGate,
    row.abstain.answered,
    row.abstain.generationFailed,
  ];
}

function renderedSweepLine(
  markdown: string,
  row: CutSweepRow,
): string | undefined {
  const expected = renderedSweepValues(row);
  return markdown
    .split('\n')
    .find((line) => lineContainsNumberMultiset(line, expected));
}

function lineContainsNumberMultiset(line: string, expected: number[]): boolean {
  const remaining = integerValuesIn(line);
  for (const value of expected) {
    const index = remaining.indexOf(value);
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}

function hasEmptyGenerationGateSection(markdown: string): boolean {
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index];
    if (
      !/^#{1,6}\s+/.test(heading) ||
      !heading.includes('생성') ||
      !/(발화|기권|게이트)/u.test(heading) ||
      /(스윕|컷)/u.test(heading)
    ) {
      continue;
    }

    const body: string[] = [];
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      if (/^#{1,6}\s+/.test(lines[bodyIndex])) break;
      body.push(lines[bodyIndex]);
    }
    if (/없음/u.test(body.join('\n'))) return true;
  }
  return false;
}

describe('이슈 #348: RAG 오프라인 평가 생성 게이트', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pool: Pool;
  let mainApp: INestApplication;
  let lowScoreApp: INestApplication;
  let distanceGateApp: INestApplication;
  let failureApp: INestApplication;

  let mixedReport: RagEvalReport;
  let answerableReport: RagEvalReport;
  let allInsufficientReport: RagEvalReport;
  let noVerdictReport: RagEvalReport;
  let generationOffReport: RagEvalReport;
  let lowScoreReport: RagEvalReport;
  let distanceGateReport: RagEvalReport;
  let failureReport: RagEvalReport;

  let mixedGenerationCalls: RecordedGenerationCall[] = [];
  let mixedRerankCalls: RecordedRerankCall[] = [];
  let defaultOnGenerationCalls: RecordedGenerationCall[] = [];
  let generationOffCalls: RecordedGenerationCall[] = [];
  let lowScoreGenerationCalls: RecordedGenerationCall[] = [];
  let distanceGateGenerationCalls: RecordedGenerationCall[] = [];

  let mixedMarkdown = '';
  let noVerdictMarkdown = '';
  let failureMarkdown = '';
  let generationOffMarkdown = '';

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

  const mainProvider = new RecordingProvider(
    'rag-eval-generation-mixed-provider',
    'mixed',
  );
  const lowScoreProvider = new RecordingProvider(
    'rag-eval-generation-low-score-provider',
    'no_verdict',
  );
  const distanceGateProvider = new RecordingProvider(
    'rag-eval-generation-distance-provider',
    'no_verdict',
  );
  const failureProvider = new AlwaysFailingProvider();

  const mainReranker = new RecordingReranker(
    'rag-eval-reverse-reranker',
    true,
    mixedRelevanceOf,
  );
  const lowScoreReranker = new RecordingReranker(
    'rag-eval-low-score-reranker',
    false,
    LOW_RELEVANCE,
  );
  const distanceGateReranker = new RecordingReranker(
    'rag-eval-distance-reranker',
    false,
    HIGH_RELEVANCE,
  );
  const failureReranker = new RecordingReranker(
    'rag-eval-failure-reranker',
    false,
    HIGH_RELEVANCE,
  );

  const createApp = async (
    provider: LlmProvider,
    reranker: Reranker,
    config: TestRetrievalConfig,
  ): Promise<INestApplication> => {
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
      .useValue(config)
      .compile();

    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    await bootstrapApp(app);
    return app;
  };

  beforeAll(async () => {
    [postgresContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg17').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    process.env.DATABASE_URL = postgresContainer.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();
    process.env.OPENAI_API_KEY = '';

    pool = new Pool({ connectionString: postgresContainer.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle/migrations' });

    mainApp = await createApp(mainProvider, mainReranker, passConfig);
    lowScoreApp = await createApp(
      lowScoreProvider,
      lowScoreReranker,
      passConfig,
    );
    distanceGateApp = await createApp(
      distanceGateProvider,
      distanceGateReranker,
      { ...passConfig, distanceCutoff: SMALL_DISTANCE_CUTOFF },
    );
    failureApp = await createApp(
      failureProvider,
      failureReranker,
      passConfig,
    );

    // 네 앱이 같은 코퍼스를 공유하므로 인제스트는 정확히 한 번만 한다.
    await mainApp.get(GuidelineIngestService).ingest(yotongGuideline);

    const mainService = mainApp.get(RagEvalService);

    mainProvider.setMode('mixed');
    mainReranker.setRelevance(mixedRelevanceOf);
    const mixedGenerationStart = mainProvider.calls.length;
    const mixedRerankStart = mainReranker.calls.length;
    mixedReport = await mainService.evaluate(evaluationItems);
    mixedGenerationCalls = mainProvider.calls.slice(mixedGenerationStart);
    mixedRerankCalls = mainReranker.calls.slice(mixedRerankStart);

    mainReranker.setRelevance(HIGH_RELEVANCE);
    mainProvider.setMode('answerable');
    answerableReport = await mainService.evaluate(evaluationItems);

    mainProvider.setMode('insufficient');
    allInsufficientReport = await mainService.evaluate(evaluationItems);

    mainProvider.setMode('no_verdict');
    const defaultOnStart = mainProvider.calls.length;
    noVerdictReport = await mainService.evaluate(evaluationItems);
    defaultOnGenerationCalls = mainProvider.calls.slice(defaultOnStart);

    const generationOffStart = mainProvider.calls.length;
    generationOffReport = await mainService.evaluate(evaluationItems, {
      generation: false,
    });
    generationOffCalls = mainProvider.calls.slice(generationOffStart);

    const lowScoreStart = lowScoreProvider.calls.length;
    lowScoreReport = await lowScoreApp
      .get(RagEvalService)
      .evaluate(evaluationItems);
    lowScoreGenerationCalls = lowScoreProvider.calls.slice(lowScoreStart);

    const distanceGateStart = distanceGateProvider.calls.length;
    distanceGateReport = await distanceGateApp
      .get(RagEvalService)
      .evaluate(evaluationItems);
    distanceGateGenerationCalls = distanceGateProvider.calls.slice(
      distanceGateStart,
    );

    failureReport = await failureApp
      .get(RagEvalService)
      .evaluate(evaluationItems);

    mixedMarkdown = renderEvalReport(mixedReport);
    noVerdictMarkdown = renderEvalReport(noVerdictReport);
    failureMarkdown = renderEvalReport(failureReport);
    generationOffMarkdown = renderEvalReport(generationOffReport);
  });

  afterAll(async () => {
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('REDIS_URL', originalRedisUrl);
    restoreEnv('OPENAI_API_KEY', originalOpenAiApiKey);

    await failureApp?.close();
    await distanceGateApp?.close();
    await lowScoreApp?.close();
    await mainApp?.close();
    await pool?.end();
    await Promise.all([
      postgresContainer?.stop(),
      redisContainer?.stop(),
    ]);
  });

  describe('A. 문항별 판정 기록', () => {
    it('기준 A1: answerable과 abstain 전 문항의 생성 판정을 기록한다', () => {
      expect(mixedReport.generationVerdicts).toHaveLength(
        mixedReport.answerableCount + mixedReport.abstainCount,
      );
      expect(
        mixedReport.generationVerdicts.filter(
          (verdict) => verdict.kind === 'abstain',
        ),
      ).toHaveLength(mixedReport.abstainCount);
    });

    it('기준 A2: 각 판정은 원 문항의 itemId·kind·question을 그대로 싣는다', () => {
      for (const item of evaluationItems) {
        expect(verdictOf(mixedReport, item.id)).toMatchObject({
          itemId: item.id,
          kind: item.kind,
          question: item.question,
        });
      }
    });

    it("기준 A3: insufficientEvidence=true 판정은 status='insufficient'다", () => {
      expect(verdictOf(mixedReport, answerableSample.id).status).toBe(
        'insufficient',
      );
    });

    it("기준 A4: insufficientEvidence=false 판정은 status='answerable'이다", () => {
      for (const item of evaluationItems) {
        expect(verdictOf(answerableReport, item.id).status).toBe('answerable');
      }
    });

    it("기준 A5: verdict 미방출 스트림은 status='no_verdict'다", () => {
      expect(verdictOf(mixedReport, abstainSample.id).status).toBe(
        'no_verdict',
      );
    });

    it('기준 A6: 발화 판정의 missingAspects는 프로바이더가 방출한 값을 보존한다', () => {
      expect(verdictOf(mixedReport, answerableSample.id).missingAspects).toEqual(
        [MODEL_MISSING_ASPECT],
      );
    });

    it("기준 A7: 누락 축이 있는 발화의 cause는 'model_verdict'다", () => {
      expect(verdictOf(mixedReport, answerableSample.id).cause).toBe(
        'model_verdict',
      );
    });

    it("기준 A8: 누락 축이 빈 발화의 cause는 'empty_aspects'다", () => {
      const verdict = verdictOf(mixedReport, sectionPathSample.id);
      expect(verdict.status).toBe('insufficient');
      expect(verdict.missingAspects).toEqual([]);
      expect(verdict.cause).toBe('empty_aspects');
    });

    it("기준 A9: 'answerable'과 'no_verdict' 판정의 cause는 null이다", () => {
      expect(verdictOf(answerableReport, answerableSample.id)).toMatchObject({
        status: 'answerable',
        cause: null,
      });
      expect(verdictOf(mixedReport, abstainSample.id)).toMatchObject({
        status: 'no_verdict',
        cause: null,
      });
    });

    it('기준 A10: 각 판정의 top1Relevance는 그 문항에 주입한 원 리랭크 점수다', () => {
      for (const item of evaluationItems) {
        const rerankCall = rerankCallOf(mixedRerankCalls, item.question);
        expect(verdictOf(mixedReport, item.id).top1Relevance).toBe(
          rerankCall.top1Relevance,
        );
      }
    });

    it('기준 A11: 생성 측정 리포트는 PROMPT_VERSION을 기록한다', () => {
      expect(mixedReport.generationMeasured).toBe(true);
      expect(mixedReport.promptVersion).toBe(PROMPT_VERSION);
    });
  });

  describe('B. 컷과 무관한 전 문항 생성 및 리랭크 top-K 근거', () => {
    it('기준 B1: 점수 게이트가 전 문항을 잘라도 생성은 전 문항에 호출된다', () => {
      expect(lowScoreReport.rerankedOverAbstainRate).toBe(1);
      expect(lowScoreReport.rerankedAbstainRecall).toBe(1);
      expect(lowScoreGenerationCalls).toHaveLength(evaluationItems.length);
    });

    it('기준 B2: 거리 게이트가 전 문항을 잘라도 생성은 전 문항에 호출된다', () => {
      expect(distanceGateReport.overAbstainRate).toBe(1);
      expect(distanceGateReport.abstainRecall).toBe(1);
      expect(distanceGateGenerationCalls).toHaveLength(evaluationItems.length);
    });

    it('기준 B3: 생성 입력 근거는 RETRIEVAL_TOP_K개를 넘지 않는다', () => {
      expect(mixedGenerationCalls).toHaveLength(evaluationItems.length);
      for (const call of mixedGenerationCalls) {
        expect(call.evidence.length).toBeGreaterThan(0);
        expect(call.evidence.length).toBeLessThanOrEqual(RETRIEVAL_TOP_K);
      }
    });

    it('기준 B4: 생성 입력은 코사인 순서가 아닌 리랭커 역순의 상위 K개다', () => {
      for (const item of evaluationItems) {
        const rerankCall = rerankCallOf(mixedRerankCalls, item.question);
        const generationCall = generationCallOf(
          mixedGenerationCalls,
          item.question,
        );
        expect(rerankCall.candidates.length).toBeGreaterThan(1);

        const project = (
          candidate: Pick<RerankCandidate, 'content' | 'guidelineTitle'>,
        ): Pick<RerankCandidate, 'content' | 'guidelineTitle'> => ({
          content: candidate.content,
          guidelineTitle: candidate.guidelineTitle,
        });
        const expected = [...rerankCall.candidates]
          .reverse()
          .slice(0, RETRIEVAL_TOP_K)
          .map(project);
        const cosineTopK = rerankCall.candidates
          .slice(0, RETRIEVAL_TOP_K)
          .map(project);
        const received = generationCall.evidence.map(project);

        expect(expected).not.toEqual(cosineTopK);
        expect(received).toEqual(expected);
      }
    });

    it('기준 B5: 생성 입력 근거 marker는 1부터 연속 증가한다', () => {
      expect(mixedGenerationCalls).toHaveLength(evaluationItems.length);
      for (const call of mixedGenerationCalls) {
        expect(call.evidence.length).toBeGreaterThan(0);
        expect(call.evidence.map((evidence) => evidence.marker)).toEqual(
          Array.from({ length: call.evidence.length }, (_, index) => index + 1),
        );
      }
    });
  });

  describe('C. 컷 스윕', () => {
    it('기준 C1: 컷 스윕은 0부터 10까지 오름차순 정수 11행이다', () => {
      expectCompleteSweep(mixedReport);
    });

    it('기준 C2: 매 컷 answerable 네 갈래의 합은 answerable 문항 수다', () => {
      expectCompleteSweep(mixedReport);
      for (const row of mixedReport.cutSweep) {
        expect(breakdownTotal(row.answerable)).toBe(
          mixedReport.answerableCount,
        );
      }
    });

    it('기준 C3: 매 컷 abstain 네 갈래의 합은 abstain 문항 수다', () => {
      expectCompleteSweep(mixedReport);
      for (const row of mixedReport.cutSweep) {
        expect(breakdownTotal(row.abstain)).toBe(mixedReport.abstainCount);
      }
    });

    it('기준 C4: 점수 10과 거리 통과 구성은 컷 0~10에서 검색 게이트가 0이다', () => {
      expectCompleteSweep(noVerdictReport);
      for (const row of noVerdictReport.cutSweep) {
        expect(retrievalGateTotal(row)).toBe(0);
      }
    });

    it('기준 C5: 점수 0은 컷 0에서 통과하고 컷 1~10에서 전 문항 검색 게이트다', () => {
      expectCompleteSweep(lowScoreReport);
      expect(retrievalGateTotal(sweepRowOf(lowScoreReport, 0))).toBe(0);
      for (const cutoff of SWEEP_CUTOFFS.slice(1)) {
        expect(retrievalGateTotal(sweepRowOf(lowScoreReport, cutoff))).toBe(
          evaluationItems.length,
        );
      }
    });

    it('기준 C6: 고정 거리 게이트는 컷 0에서도 전 문항을 자른다', () => {
      expectCompleteSweep(distanceGateReport);
      expect(retrievalGateTotal(sweepRowOf(distanceGateReport, 0))).toBe(
        evaluationItems.length,
      );
    });

    it('기준 C7: 검색 게이트 수는 컷이 오를수록 감소하지 않고 원 점수로 전환된다', () => {
      expectCompleteSweep(mixedReport);
      for (const kind of ['answerable', 'abstain'] as const) {
        const counts = mixedReport.cutSweep.map(
          (row) => row[kind].retrievalGate,
        );
        for (let index = 1; index < counts.length; index += 1) {
          expect(counts[index]).toBeGreaterThanOrEqual(counts[index - 1]);
        }
      }

      // 7.75를 반올림해 8로 버킷팅하면 컷 8에서 통과하므로 이 대조가 깨진다.
      expect(sweepRowOf(mixedReport, 7).answerable.retrievalGate).toBe(1);
      expect(sweepRowOf(mixedReport, 8).answerable.retrievalGate).toBe(2);
      expect(sweepRowOf(mixedReport, 4).abstain.retrievalGate).toBe(0);
      expect(sweepRowOf(mixedReport, 5).abstain.retrievalGate).toBe(1);
    });

    it('기준 C8: 전 문항 발화 구성은 검색 통과분 전부가 생성 게이트로 간다', () => {
      expectCompleteSweep(allInsufficientReport);
      for (const row of allInsufficientReport.cutSweep) {
        expect(row.answerable).toMatchObject({
          retrievalGate: 0,
          generationGate: allInsufficientReport.answerableCount,
          answered: 0,
        });
        expect(row.abstain).toMatchObject({
          retrievalGate: 0,
          generationGate: allInsufficientReport.abstainCount,
          answered: 0,
        });
      }
    });

    it('기준 C9: verdict 미방출은 생성 게이트가 아니라 answered로 센다', () => {
      expectCompleteSweep(noVerdictReport);
      for (const row of noVerdictReport.cutSweep) {
        expect(row.answerable).toMatchObject({
          retrievalGate: 0,
          generationGate: 0,
          answered: noVerdictReport.answerableCount,
        });
        expect(row.abstain).toMatchObject({
          retrievalGate: 0,
          generationGate: 0,
          answered: noVerdictReport.abstainCount,
        });
      }
    });

    it('기준 C10: 생성 실패는 generationFailed로 가고 answered에 섞이지 않는다', () => {
      expectCompleteSweep(failureReport);
      for (const row of failureReport.cutSweep) {
        expect(row.answerable).toMatchObject({
          retrievalGate: 0,
          generationFailed: failureReport.answerableCount,
          answered: 0,
        });
        expect(row.abstain).toMatchObject({
          retrievalGate: 0,
          generationFailed: failureReport.abstainCount,
          answered: 0,
        });
      }
    });

    it('기준 C11: generation=false면 생성 축은 0이고 검색 통과분은 answered로 간다', () => {
      expectCompleteSweep(generationOffReport);
      for (const row of generationOffReport.cutSweep) {
        expect(row.answerable).toMatchObject({
          retrievalGate: 0,
          generationGate: 0,
          generationFailed: 0,
          answered: generationOffReport.answerableCount,
        });
        expect(row.abstain).toMatchObject({
          retrievalGate: 0,
          generationGate: 0,
          generationFailed: 0,
          answered: generationOffReport.abstainCount,
        });
      }
    });
  });

  describe('D. 생성 실패 격리', () => {
    it('기준 D1: 프로바이더가 항상 실패해도 evaluate는 리포트를 반환한다', async () => {
      await expect(
        failureApp.get(RagEvalService).evaluate(evaluationItems),
      ).resolves.toEqual(
        expect.objectContaining({
          generationMeasured: true,
          generationVerdicts: expect.any(Array),
        }),
      );
    });

    it("기준 D2: 실패 실행의 모든 문항 status는 'failed'다", () => {
      expect(failureReport.generationVerdicts).toHaveLength(
        evaluationItems.length,
      );
      for (const item of evaluationItems) {
        expect(verdictOf(failureReport, item.id).status).toBe('failed');
      }
    });

    it('기준 D3: 실패 문항의 failureReason은 빈 문자열이 아니다', () => {
      for (const item of evaluationItems) {
        const verdict = verdictOf(failureReport, item.id);
        expect(verdict.status).toBe('failed');
        expect(verdict.failureReason).toEqual(expect.any(String));
        expect(verdict.failureReason).not.toBe('');
      }
    });

    it('기준 D4: 생성 실패 실행도 정상 실행과 같은 검색 지표를 보존한다', () => {
      expect(failureReport.generationVerdicts).toHaveLength(
        evaluationItems.length,
      );
      expect({
        recallAt5: failureReport.recallAt5,
        mrrAt5: failureReport.mrrAt5,
        recallAt30: failureReport.recallAt30,
      }).toEqual({
        recallAt5: noVerdictReport.recallAt5,
        mrrAt5: noVerdictReport.mrrAt5,
        recallAt30: noVerdictReport.recallAt30,
      });
    });
  });

  describe('E. 생성 측정 스위치', () => {
    it('기준 E1: generation=false면 프로바이더를 한 번도 호출하지 않는다', () => {
      // 기본 on 양성 대조가 있어 스텁의 무호출로 공허하게 통과할 수 없다.
      expect(defaultOnGenerationCalls).toHaveLength(evaluationItems.length);
      expect(generationOffCalls).toHaveLength(0);
    });

    it('기준 E2: generation=false 리포트는 generationMeasured=false다', () => {
      expect(noVerdictReport.generationMeasured).toBe(true);
      expect(generationOffReport.generationMeasured).toBe(false);
    });

    it('기준 E3: generation=false 리포트의 generationVerdicts는 빈 배열이다', () => {
      expect(noVerdictReport.generationVerdicts).toHaveLength(
        evaluationItems.length,
      );
      expect(generationOffReport.generationVerdicts).toEqual([]);
    });

    it('기준 E4: generation=false 리포트의 promptVersion은 빈 문자열이다', () => {
      expect(noVerdictReport.promptVersion).toBe(PROMPT_VERSION);
      expect(generationOffReport.promptVersion).toBe('');
    });

    it('기준 E5: 옵션을 생략하면 생성 측정은 기본으로 켜진다', () => {
      expect(noVerdictReport.generationMeasured).toBe(true);
      expect(defaultOnGenerationCalls).toHaveLength(evaluationItems.length);
    });

    it('기준 E6: generation=false와 기본 실행의 다섯 검색 순위 지표는 같다', () => {
      expect(noVerdictReport.generationMeasured).toBe(true);
      expect(generationOffReport.generationMeasured).toBe(false);
      expect(searchMetricsOf(generationOffReport)).toEqual(
        searchMetricsOf(noVerdictReport),
      );
    });

    it('기준 E7: generation=false와 기본 실행의 네 기권 지표는 같다', () => {
      expect(noVerdictReport.generationMeasured).toBe(true);
      expect(generationOffReport.generationMeasured).toBe(false);
      expect(abstainMetricsOf(generationOffReport)).toEqual(
        abstainMetricsOf(noVerdictReport),
      );
    });
  });

  describe('F. 리포트 렌더링', () => {
    it('기준 F1: 마크다운 컷 스윕 표에는 컷 0~10의 서로 다른 11행이 있다', () => {
      expectCompleteSweep(mixedReport);
      const renderedLines = mixedReport.cutSweep.map((row) =>
        renderedSweepLine(mixedMarkdown, row),
      );
      expect(renderedLines.every((line) => line !== undefined)).toBe(true);
      expect(new Set(renderedLines).size).toBe(SWEEP_CUTOFFS.length);
    });

    it('기준 F2: 각 컷 행은 값이 갈리는 answerable의 검색·생성·답변 수를 함께 싣는다', () => {
      expect(mixedReport.generationMeasured).toBe(true);
      expect(
        mixedReport.cutSweep.some(
          (row) =>
            row.answerable.retrievalGate > 0 &&
            row.answerable.generationGate > 0,
        ),
      ).toBe(true);

      for (const row of mixedReport.cutSweep) {
        const line = renderedSweepLine(mixedMarkdown, row);
        expect(line).toBeDefined();
        expect(
          lineContainsNumberMultiset(line ?? '', [
            row.cutoff,
            row.answerable.retrievalGate,
            row.answerable.generationGate,
            row.answerable.answered,
          ]),
        ).toBe(true);
      }
    });

    it('기준 F3: 각 컷 행은 값이 갈리는 abstain의 검색·생성·답변 수를 함께 싣는다', () => {
      expect(mixedReport.generationMeasured).toBe(true);
      expect(
        mixedReport.cutSweep.some((row) => row.abstain.retrievalGate > 0),
      ).toBe(true);
      expect(
        mixedReport.cutSweep.some((row) => row.abstain.answered > 0),
      ).toBe(true);

      for (const row of mixedReport.cutSweep) {
        const line = renderedSweepLine(mixedMarkdown, row);
        expect(line).toBeDefined();
        expect(
          lineContainsNumberMultiset(line ?? '', [
            row.cutoff,
            row.abstain.retrievalGate,
            row.abstain.generationGate,
            row.abstain.answered,
          ]),
        ).toBe(true);
      }
    });

    it('기준 F4: 마크다운은 생성 게이트 발화 문항 itemId를 나열한다', () => {
      expect(mixedReport.generationMeasured).toBe(true);
      const triggered = mixedReport.generationVerdicts.filter(
        (verdict) => verdict.status === 'insufficient',
      );
      expect(triggered).toHaveLength(2);
      for (const verdict of triggered) {
        expect(mixedMarkdown).toContain(verdict.itemId);
      }
    });

    it('기준 F5: 발화 문항 목록에는 model_verdict와 empty_aspects cause가 실린다', () => {
      expect(mixedReport.generationMeasured).toBe(true);
      const causes = mixedReport.generationVerdicts
        .filter((verdict) => verdict.status === 'insufficient')
        .map((verdict) => verdict.cause);
      expect(new Set(causes)).toEqual(
        new Set(['model_verdict', 'empty_aspects']),
      );
      expect(mixedMarkdown).toContain('model_verdict');
      expect(mixedMarkdown).toContain('empty_aspects');
    });

    it('기준 F6: 생성 게이트 발화가 0건이면 해당 절에 없음이라고 명시한다', () => {
      expect(noVerdictReport.generationMeasured).toBe(true);
      expect(
        noVerdictReport.generationVerdicts.filter(
          (verdict) => verdict.status === 'insufficient',
        ),
      ).toHaveLength(0);
      expect(hasEmptyGenerationGateSection(noVerdictMarkdown)).toBe(true);
    });

    it('기준 F7: 마크다운은 생성 실패 문항 itemId와 실패 사유를 싣는다', () => {
      expect(failureReport.generationMeasured).toBe(true);
      for (const item of evaluationItems) {
        const verdict = verdictOf(failureReport, item.id);
        expect(verdict.status).toBe('failed');
        expect(verdict.failureReason).toEqual(expect.any(String));
        expect(failureMarkdown).toContain(item.id);
        expect(failureMarkdown).toContain(verdict.failureReason ?? '');
      }
    });

    it('기준 F8: generationMeasured=false 마크다운은 생성을 측정하지 않았다고 명시한다', () => {
      expect(noVerdictReport.generationMeasured).toBe(true);
      expect(generationOffReport.generationMeasured).toBe(false);
      expect(generationOffMarkdown).toMatch(
        /생성[\s\S]{0,120}(측정하지|미측정|비활성|off)/iu,
      );
    });

    it('기준 F9: 마크다운은 측정에 사용한 promptVersion 값을 싣는다', () => {
      expect(mixedReport.promptVersion).toBe(PROMPT_VERSION);
      expect(mixedMarkdown).toContain(PROMPT_VERSION);
    });
  });
});
