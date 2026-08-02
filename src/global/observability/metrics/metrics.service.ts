/**
 * Prometheus 메트릭 레지스트리 (docs/specs/12 §운영 관측).
 *
 * 전역 레지스트리(prom-client의 기본 register) 대신 인스턴스 레지스트리를 쓴다 —
 * 테스트에서 모듈이 반복 생성될 때 "metric already registered"로 깨지지 않게 하기 위함이다.
 *
 * 라벨 카디널리티 원칙: 사용자 입력에서 유래한 값(경로 파라미터·쿼리·traceId)은 라벨에 넣지 않는다.
 * HTTP route는 express가 매칭한 라우트 패턴(`/api/v1/conversations/:conversationId`)만 쓴다.
 */
import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** LLM 호출 1회의 결말 — 폴백 라우터가 프로바이더별로 기록한다 */
export type LlmOutcome = 'success' | 'failure' | 'rate_limited' | 'skipped';

/** SSE 스트림의 종료 사유 */
export type SseOutcome = 'completed' | 'aborted' | 'failed';

/** 지침 파이프라인 **단계 자체의 결말** — 실행 status enum과는 다른 축이다 (docs/specs/22) */
export type PipelineStageOutcome = 'success' | 'failure' | 'skipped';

/**
 * 검색 파이프라인의 단계 — 사용자 체감 지연을 임베딩과 조회로 가른다 (docs/specs/27).
 * 하이브리드에서 키워드 arm이 더해지며 조회 축이 둘이 된다 (docs/specs/31).
 */
export type RetrievalStage = 'embed' | 'vector_search' | 'keyword_search';

/**
 * 답변 1회의 결말 (docs/specs/27).
 * `sse_streams_total`과 다른 축이다 — abstain도 스트림으로는 `completed`이므로
 * 그 축에서는 정상 답변과 구분되지 않는다.
 */
export type RagAnswerOutcome = 'answered' | 'abstained' | 'failed';

/**
 * 기권의 사유 (docs/specs/28) — abstain 급등이 「코퍼스 사고(no_candidates)인가,
 * 범위 밖 질문 유입(beyond_cutoff)인가」를 이 축이 가른다.
 */
export type AbstainReason = 'no_candidates' | 'beyond_cutoff';

/** 리랭크 1회의 결말 (docs/specs/29) — fallback 상시화는 이 축이 잡는다 */
export type RerankOutcome = 'reranked' | 'fallback';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** HTTP 요청 수 — 요청률(R)과 에러율(E)의 원천 */
  private readonly httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP 요청 수',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });

  /** HTTP 응답 지연(D) — p95/p99는 histogram_quantile로 계산한다 */
  private readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP 요청 처리 시간(초)',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  /** 프로바이더별 LLM 호출 결말 — 폴백이 얼마나 자주 도는지 여기서 드러난다 */
  private readonly llmRequests = new Counter({
    name: 'llm_requests_total',
    help: 'LLM 프로바이더 호출 수',
    labelNames: ['provider', 'outcome'] as const,
    registers: [this.registry],
  });

  /** LLM 지연 — 스트리밍 전체 소요. HTTP보다 훨씬 길어 버킷을 따로 잡는다 */
  private readonly llmDuration = new Histogram({
    name: 'llm_request_duration_seconds',
    help: 'LLM 프로바이더 응답 시간(초)',
    labelNames: ['provider'] as const,
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120],
    registers: [this.registry],
  });

  /** 토큰 소비량 — 비용 추적의 근거. 프로바이더가 usage를 보고할 때만 증가한다 */
  private readonly llmTokens = new Counter({
    name: 'llm_tokens_total',
    help: 'LLM 토큰 소비량',
    labelNames: ['provider', 'model', 'kind'] as const,
    registers: [this.registry],
  });

  /** 서킷 open 여부(1=open) — Discord 알림은 전이 순간만 알려주므로 상태는 여기서 본다 */
  private readonly llmCircuitOpen = new Gauge({
    name: 'llm_circuit_open',
    help: 'LLM 프로바이더 서킷 open 여부 (1=open, 0=closed)',
    labelNames: ['provider'] as const,
    registers: [this.registry],
  });

  /** 전 프로바이더 소진 — 사용자에게 LLM_UNAVAILABLE이 나간 횟수 */
  private readonly llmExhausted = new Counter({
    name: 'llm_exhausted_total',
    help: '가용 LLM 프로바이더 소진 횟수',
    registers: [this.registry],
  });

  /** 진행 중인 SSE 스트림 수 — 커넥션 누수 감지용 */
  private readonly sseActive = new Gauge({
    name: 'sse_active_streams',
    help: '진행 중인 SSE 스트림 수',
    registers: [this.registry],
  });

  private readonly sseStreams = new Counter({
    name: 'sse_streams_total',
    help: 'SSE 스트림 종료 수',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  /**
   * 지침 파이프라인 단계별 소요 (docs/specs/22).
   * `pipeline_runs`는 «무엇이 왜 실패했나»에 답하지만 추이는 답하지 못한다 — 단계별 소요·실패율을
   * DB에 쌓으면 테이블이 시계열 DB 흉내를 내므로 그쪽은 여기로 보낸다.
   */
  private readonly pipelineStageDuration = new Histogram({
    name: 'guideline_pipeline_stage_duration_seconds',
    help: '지침 파이프라인 단계별 소요 시간',
    labelNames: ['stage'] as const,
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
    registers: [this.registry],
  });

  private readonly pipelineStages = new Counter({
    name: 'guideline_pipeline_stage_total',
    help: '지침 파이프라인 단계 종료 수',
    labelNames: ['stage', 'status'] as const,
    registers: [this.registry],
  });

  /**
   * 검색 단계별 소요 (docs/specs/27).
   * LLM 지연은 이미 보이는데 그 앞단이 사각지대였다 — "답변이 느리다"가 임베딩인지 벡터 조회인지
   * LLM인지 이 축에서 갈린다. 버킷이 LLM보다 훨씬 촘촘한 이유는 여기가 ms대이기 때문이다.
   */
  private readonly retrievalDuration = new Histogram({
    name: 'rag_retrieval_duration_seconds',
    help: '검색 단계별 소요 시간(초)',
    labelNames: ['stage'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  /**
   * 검색이 반환한 청크 수. **0건도 관측한다** — 0이 곧 abstain의 원인이고,
   * 임베딩 모델을 바꿨을 때 재인제스트 전까지 전건 0이 되는 사고(docs/specs/14)가 여기서 드러난다.
   */
  private readonly retrievedChunks = new Histogram({
    name: 'rag_retrieved_chunks',
    help: '검색이 반환한 근거 청크 수',
    buckets: [0, 1, 2, 3, 4, 5],
    registers: [this.registry],
  });

  /**
   * top-1 코사인 거리 (docs/specs/27).
   * 지금 검색에는 유사도 임계값이 없다 — 컷을 감으로 정하면 과잉기권이거나 무용이므로,
   * 이 분포가 컷의 근거가 된다. 결과가 0건이면 관측하지 않는다(잴 대상이 없다).
   */
  private readonly top1Distance = new Histogram({
    name: 'rag_top1_distance',
    help: '검색 top-1의 코사인 거리',
    buckets: [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0],
    registers: [this.registry],
  });

  /**
   * 답변 1회의 결말 (docs/specs/27).
   * `sse_streams_total`과 축이 다르다 — abstain도 스트림으로는 `completed`라 그 축에서는
   * 정상 답변과 구분되지 않는다. abstain율 급등은 인제스트 사고의 조기 경보이므로 별도로 센다.
   */
  private readonly ragAnswers = new Counter({
    name: 'rag_answers_total',
    help: '답변 결말 수',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  /**
   * 기권 사유별 카운트 (docs/specs/28).
   * `rag_answers_total{outcome="abstained"}`의 분해 축이다 — 라벨을 그 메트릭에 더하면
   * answered 시계열까지 빈 라벨이 번지므로 별도 카운터로 둔다. abstain 급등 시
   * 「코퍼스 사고(no_candidates)인가, 범위 밖 질문 유입(beyond_cutoff)인가」가 여기서 갈린다.
   */
  private readonly ragAbstains = new Counter({
    name: 'rag_abstains_total',
    help: '기권 사유별 수',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  /** 리랭크 결말 (docs/specs/29) — fallback이 조용히 상시화되면 이 축이 잡는다 */
  private readonly rerankTotal = new Counter({
    name: 'rag_rerank_total',
    help: '리랭크 시도 결말 수',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  /** 리랭크 호출 소요 — 실측 p50 0.96s·p90 1.29s (docs/specs/29). TTFT 예산 감시용 */
  private readonly rerankDuration = new Histogram({
    name: 'rag_rerank_duration_seconds',
    help: '리랭크 호출 소요 시간(초)',
    buckets: [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10],
    registers: [this.registry],
  });

  constructor() {
    // 이벤트 루프 지연·힙·GC·핸들 수 — Node 앱 병목 판별의 기본 지표
    collectDefaultMetrics({ register: this.registry });
  }

  /**
   * 단계가 **끝날 때 1회만** 기록한다 — 그래서 RUNNING·INTERRUPTED에 대응하는 라벨 값이 없다
   * (중단된 단계는 프로세스가 죽어 애초에 기록되지 않는다).
   * `status`는 실행 status enum이 아니라 **그 단계 자체의 결말**이다.
   */
  recordPipelineStage(stage: string, status: PipelineStageOutcome, durationSec: number): void {
    this.pipelineStageDuration.observe({ stage }, durationSec);
    this.pipelineStages.inc({ stage, status });
  }

  recordRetrievalStage(stage: RetrievalStage, durationSec: number): void {
    this.retrievalDuration.observe({ stage }, durationSec);
  }

  /** 0건도 기록한다 — 0이 곧 abstain의 원인이다 */
  recordRetrievedChunks(count: number): void {
    this.retrievedChunks.observe(count);
  }

  recordTop1Distance(distance: number): void {
    this.top1Distance.observe(distance);
  }

  recordAnswerOutcome(outcome: RagAnswerOutcome): void {
    this.ragAnswers.inc({ outcome });
  }

  recordAbstain(reason: AbstainReason): void {
    this.ragAbstains.inc({ reason });
  }

  recordRerank(outcome: RerankOutcome, durationSec: number): void {
    this.rerankTotal.inc({ outcome });
    this.rerankDuration.observe(durationSec);
  }

  recordHttpRequest(method: string, route: string, status: number, durationSec: number): void {
    const labels = { method, route, status: String(status) };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, durationSec);
  }

  recordLlmOutcome(provider: string, outcome: LlmOutcome): void {
    this.llmRequests.inc({ provider, outcome });
  }

  recordLlmDuration(provider: string, durationSec: number): void {
    this.llmDuration.observe({ provider }, durationSec);
  }

  recordLlmTokens(provider: string, model: string, input: number, output: number): void {
    if (input > 0) this.llmTokens.inc({ provider, model, kind: 'input' }, input);
    if (output > 0) this.llmTokens.inc({ provider, model, kind: 'output' }, output);
  }

  setLlmCircuitOpen(provider: string, open: boolean): void {
    this.llmCircuitOpen.set({ provider }, open ? 1 : 0);
  }

  recordLlmExhausted(): void {
    this.llmExhausted.inc();
  }

  sseStreamStarted(): void {
    this.sseActive.inc();
  }

  sseStreamEnded(outcome: SseOutcome): void {
    this.sseActive.dec();
    this.sseStreams.inc({ outcome });
  }

  /** Prometheus 텍스트 노출 포맷 */
  scrape(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
