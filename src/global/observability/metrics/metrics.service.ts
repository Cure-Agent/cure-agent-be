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

  constructor() {
    // 이벤트 루프 지연·힙·GC·핸들 수 — Node 앱 병목 판별의 기본 지표
    collectDefaultMetrics({ register: this.registry });
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
