import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ulid } from 'ulid';
import { monotonicUlid } from '../../../global/common/id/monotonic-ulid';
import { ErrorCode, ErrorCodes } from '../../../global/common/exception/error-code.registry';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { TraceContext } from '../../../global/context/trace-context.service';
import {
  AbstainReason,
  MetricsService,
  RagAnswerOutcome,
  SseOutcome,
} from '../../../global/observability/metrics/metrics.service';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import {
  LlmExhaustedError,
  LlmGateway,
  LlmStreamOutcome,
} from '../../../infrastructure/llm/llm-gateway';
import {
  LlmEvidenceContext,
  LlmProviderError,
} from '../../../infrastructure/llm/llm-provider.port';
import { GUIDANCE_PROMPT_VERSION } from '../../../infrastructure/llm/guidance/guidance-prompt';
import {
  GUIDANCE_STRUCTURER,
  GuidanceEvidenceContext,
  GuidanceStructureResult,
  GuidanceStructurer,
} from '../../../infrastructure/llm/guidance/guidance-structurer.port';
import { structureWithTimeout } from '../../../infrastructure/llm/guidance/structure-runner';
import { promptVersionFor } from '../../../infrastructure/llm/prompt-builder';
import { detectQueryLanguage } from '../../../infrastructure/llm/query-language';
import {
  TRANSLATOR,
  SupportedLang,
  Translator,
} from '../../../infrastructure/llm/translation/translator.port';
import {
  RETRIEVAL_TOP_K,
  RetrievalService,
  RetrievedEvidence,
} from '../../../infrastructure/retrieval/retrieval.service';
import { RERANKER, Reranker } from '../../../infrastructure/retrieval/reranker.port';
import { ClinicalGuidanceResponseDto } from '../../clinical-guidance/dto/response/clinical-guidance.response.dto';
import { ClinicalGuidanceComposer } from '../../clinical-guidance/service/clinical-guidance-composer.service';
import { presentGuidanceProfileFields } from '../../clinical-guidance/service/guidance-profile-fields';
import { composeGuidanceQuestion } from '../../clinical-guidance/service/guidance-question';
import { toEvidenceDetail } from '../../guideline/mapper/guideline.mapper';
import {
  PatientSnapshotPayload,
  PatientSnapshotService,
} from '../../patient/service/patient-snapshot.service';
import { SendMessageRequestDto } from '../dto/request/send-message.request.dto';
import { toCitationDto, toMessageDto } from '../mapper/conversation.mapper';
import { MessageRow } from '../persistence/conversation.schema';
import { ConversationRepository } from '../repository/conversation.repository';
import { SseStream } from '../../../global/common/sse/sse-stream';
import { deriveConversationTitle } from './conversation-title.util';

/** 프로바이더가 모델을 보고하지 않는 경우(fake·테스트 프로바이더)의 기록값 */
const MODEL_LABEL = 'gateway-routed';
const QUOTE_LIMIT = 120;
const STREAM_TIMEOUT_MS = 120_000;
const PG_UNIQUE_VIOLATION = '23505';

/** 스트림 전체 상한(§8-5) 초과 — 프로바이더 장애와 구분해 LLM_TIMEOUT으로 내보낸다 */
export class StreamTimeoutError extends Error {
  constructor() {
    super(`LLM 응답이 ${STREAM_TIMEOUT_MS}ms 안에 완료되지 않았습니다`);
    this.name = 'StreamTimeoutError';
  }
}

/** 상류(LLM) 장애는 재시도로 풀리지만, 우리 쪽 결함·계약 위반은 재시도해도 같은 결과다 */
export const RETRYABLE_STREAM_FAILURES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'LLM_UNAVAILABLE',
  'LLM_TIMEOUT',
]);

/**
 * retrieval 이후 실패를 원인별 코드로 나눈다 (테스트 위해 export).
 * 예전엔 전부 LLM_UNAVAILABLE이라 DB 오류도 "AI 응답 생성이 지연" 문구로 나가 진단을 막았다.
 */
export function classifyStreamFailure(error: unknown): ErrorCode {
  if (error instanceof StreamTimeoutError) return 'LLM_TIMEOUT';
  // 소진(전 프로바이더 불가) · 첫 토큰 이후 실패로 폴백 불가한 프로바이더 오류
  if (error instanceof LlmExhaustedError || error instanceof LlmProviderError) {
    return 'LLM_UNAVAILABLE';
  }
  // 도메인 계약 위반은 자기 코드를 그대로 쓴다 (스냅샷·가이던스 생성 실패 등)
  if (error instanceof ServiceException) return error.code;
  // 나머지(DB·영속화·예상 못한 결함)는 우리 쪽 문제다
  return 'INTERNAL_ERROR';
}

/**
 * 기권 사유별 사용자 문구 (docs/specs/28 기준 5).
 * FE가 reason을 그대로 표시하므로, 「코퍼스에 근거가 없다」와 「질문이 코퍼스 범위 밖으로
 * 보인다」가 사용자에게 다르게 읽혀야 재질의를 유도할 수 있다.
 */
const ABSTAIN_REASON_MESSAGE: Record<SupportedLang, Record<AbstainReason, string>> = {
  ko: {
    no_candidates: '검색 조건에 해당하는 지침 근거를 찾지 못했습니다.',
    beyond_cutoff: '질문과 충분히 관련된 지침 근거를 찾지 못했습니다.',
    // 생성 게이트 (docs/specs/40) — 위 둘과 달리 「근거는 찾았으나 그것으로 답할 수 없다」다.
    // 재질의 방향이 다르므로(질문을 좁히는 쪽) 문구를 합치지 않는다.
    insufficient_evidence: '찾은 지침 근거만으로는 이 질문에 답하기 어렵습니다.',
  },
  /**
   * 영문판 (docs/specs/42). **BE가 문구를 계속 소유한다** — 지원 언어가 둘이고 문구가 3개뿐이라
   * `reasonCode`를 노출해 FE로 옮기는 비용이 이득보다 크다(스펙 판단표). 언어가 셋째로 늘거나
   * 문구 톤을 자주 고치게 되면 그때 옮긴다.
   *
   * 사유별로 **다르게 읽혀야** 재질의를 유도한다는 §28 기준 5의 원칙이 영어에서도 그대로다 —
   * 세 문장을 하나로 합치지 않는다.
   */
  en: {
    no_candidates: 'No guideline evidence matched the selected search filters.',
    beyond_cutoff: 'No guideline evidence was closely enough related to this question.',
    insufficient_evidence:
      'The guideline evidence found is not sufficient to answer this question.',
  },
};

/** PATIENT_GUIDANCE 스트림에서 완료 tx가 소비하는 가이던스 생성 재료 */
interface GuidanceContext {
  patientId: string;
  snapshotId: string;
  profile: PatientSnapshotPayload;
}

/**
 * SSE 스트리밍 오케스트레이터 (architecture.md §8 계약 전체).
 * message.accepted → retrieval.* → answer.delta(seq) → completed | abstained | error
 */
@Injectable()
export class ConversationStreamService {
  private readonly logger = new Logger(ConversationStreamService.name);

  constructor(
    private readonly repository: ConversationRepository,
    private readonly retrievalService: RetrievalService,
    @Inject(RERANKER) private readonly reranker: Reranker,
    private readonly llmGateway: LlmGateway,
    private readonly txManager: TransactionManager,
    private readonly traceContext: TraceContext,
    private readonly patientSnapshotService: PatientSnapshotService,
    private readonly guidanceComposer: ClinicalGuidanceComposer,
    @Inject(GUIDANCE_STRUCTURER) private readonly guidanceStructurer: GuidanceStructurer,
    // 질의 번역 (docs/specs/42) — 답변 생성용 LlmGateway와 별도 포트다(§29·§33 선례)
    @Inject(TRANSLATOR) private readonly translator: Translator,
    private readonly metrics: MetricsService,
  ) {}

  async stream(
    principal: ClinicianPrincipal,
    conversationId: string,
    dto: SendMessageRequestDto,
    res: Response,
    clientSignal: AbortSignal,
  ): Promise<void> {
    // ── SSE 시작 전 검증 — 실패는 일반 봉투 오류로 나간다 ──
    const conversation = await this.repository.findById(
      { clinicId: principal.clinicId },
      conversationId,
    );
    if (!conversation) throw new ServiceException('NOT_FOUND');

    if (await this.repository.existsByClientRequestId(dto.clientRequestId)) {
      throw new ServiceException('DUPLICATE_CLIENT_REQUEST');
    }

    /** 답변을 쓸 언어 (docs/specs/42). 미지정은 ko이며 그 경로는 오늘과 동일하다(기준 3) */
    const responseLang: SupportedLang = dto.responseLang ?? 'ko';

    // 시간순 계약(id asc = 생성순, §5.7): 같은 ms 내 순서 보장을 위해 monotonic ULID 사용
    const userMessageId = monotonicUlid();
    const assistantMessageId = monotonicUlid();
    try {
      await this.txManager.run(async () => {
        await this.repository.insertMessage({
          id: userMessageId,
          conversationId,
          role: 'USER',
          content: dto.content,
          status: 'COMPLETED',
          answerKind: null,
          clientRequestId: dto.clientRequestId,
        });
        await this.repository.insertMessage({
          id: assistantMessageId,
          conversationId,
          role: 'ASSISTANT',
          content: '',
          status: 'STREAMING',
          answerKind:
            conversation.type === 'PATIENT_GUIDANCE' ? 'CLINICAL_GUIDANCE' : 'GUIDELINE_ANSWER',
          clientRequestId: null,
          // 재조회가 요청 없이 언어를 아는 유일한 축 (docs/specs/42 기준 10·11)
          responseLang,
        });
        // 목록 최근 대화순의 기준점 — 답변 실패로 끝나도 "대화한" 사실은 남으므로 수락 시점에 올린다
        await this.repository.touchLastMessageAt(conversationId);

        /**
         * 첫 질문으로 대화 제목을 1회 확정한다 (기본 제목인 대화에만 적중 — applyAutoTitle).
         *
         * 답변 완료가 아니라 수락 시점인 이유: (1) 답변이 실패·기권으로 끝나도 목록에서 그 대화를
         * 알아볼 수 있어야 하고, (2) 같은 tx라 메시지 없이 제목만 남는 상태가 생기지 않으며,
         * (3) FE가 스트림 종결 후 대화 목록을 재조회할 때(chat-panel의 CONVERSATIONS_KEY
         * invalidate) 이미 커밋돼 있어 전용 SSE 이벤트나 폴링이 필요 없다.
         *
         * PATIENT_GUIDANCE는 제외한다 — 환자 맞춤 질문의 첫 문장에는 진단명·투약처럼 §4.5가
         * AES-GCM으로 암호화 저장하는 항목이 자연어로 섞인다. title은 평문 text 컬럼이자
         * ILIKE 검색 대상이라, 그대로 옮기면 암호화 경계를 제목 컬럼으로 우회하는 셈이 된다.
         * (환자 이름·차트번호는 애초에 저장하지 않는다 — 식별자는 비식별 caseLabel뿐이다.)
         */
        if (conversation.type === 'GUIDELINE_QA') {
          const autoTitle = deriveConversationTitle(dto.content);
          if (autoTitle) await this.repository.applyAutoTitle(conversationId, autoTitle);
        }
      });
    } catch (error) {
      // 동시 요청 경합: unique 제약이 최종 방어선
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new ServiceException('DUPLICATE_CLIENT_REQUEST');
      }
      throw error;
    }

    // ── 이후는 SSE 계약 (§8) ──
    const sse = new SseStream(res);
    const traceId = this.traceContext.traceId;

    // 진행 중 스트림 수(sse_active_streams)로 커넥션 누수를 감지한다
    this.metrics.sseStreamStarted();
    let sseOutcome: SseOutcome = 'completed';
    /**
     * 답변 결말 (docs/specs/27). `sseOutcome`과 축이 다르다 — abstain도 스트림으로는
     * `completed`라 그 축에서는 정상 답변과 구분되지 않는다.
     * null은 「세지 않는다」다 (아래 abort 주석 참조).
     */
    let ragOutcome: RagAnswerOutcome | null = 'answered';

    try {
      sse.send({
        eventType: 'message.accepted',
        requestId: dto.clientRequestId,
        userMessageId,
        assistantMessageId,
      });

      sse.send({ eventType: 'retrieval.started', requestId: dto.clientRequestId });

      /**
       * 검색 입력을 한국어로 정규화한다 (docs/specs/42).
       *
       * **검색은 언제나 한국어로 돈다** — 키워드 arm이 pg_trgm 문자 n-gram이라(§31) 영문 질의는
       * 두 arm 중 하나가 통째로 죽고, 기권률 56%인 검색이 영문에서 더 나빠진다.
       *
       * 번역 여부는 `responseLang`이 아니라 **입력 언어**가 정한다: 영문 UI에서 예시 질의문
       * (한국어 원문)을 눌러도 그 문자열은 이미 한국어라 번역할 이유가 없고, 그래야 §41 기준 27의
       * 「표시 문장 = 전송 문장」과 어긋나지 않는다. 한국어 입력이면 이 분기가 통째로 no-op이라
       * 검색에 넘어가는 문자열이 오늘과 바이트 단위로 같다(기준 1·2).
       *
       * SSE가 열린 뒤에 번역하는 이유는 실패를 **error 이벤트**로 내야 하기 때문이다(기준 7a) —
       * 여기서 던지면 handleStreamFailure가 LlmProviderError를 LLM_UNAVAILABLE로 분류한다.
       */
      let searchQuestion = dto.content;
      if (detectQueryLanguage(dto.content) !== 'ko') {
        try {
          searchQuestion = await this.translator.translate(dto.content, 'ko');
        } catch (error) {
          // 폴백이 없다 — 원문으로 검색하면 arm 하나를 잃은 채 조용히 나쁜 답을 낸다 (기준 7b)
          throw new LlmProviderError(`질의 번역 실패: ${String(error)}`, { retryable: true });
        }
      }
      /**
       * 하이브리드가 켜져 있으면 두 arm의 합집합을 후보로 연다 (docs/specs/31) —
       * 임베딩이 후보에조차 못 넣던 문항을 자구 일치가 데려온다. 꺼져 있으면 §29 그대로다.
       * 리랭크가 켜져 있으면 후보를 넓게 연다(K=30) — 순서는 리랭커가 다시 세운다 (docs/specs/29)
       */
      const hybridActive = this.retrievalService.hybridEnabled;
      const rerankActive = this.retrievalService.rerankEnabled;
      const retrieved = hybridActive
        ? await this.retrievalService.searchHybrid(searchQuestion, dto.filters)
        : rerankActive
          ? await this.retrievalService.search(
              searchQuestion,
              dto.filters,
              this.retrievalService.rerankCandidates,
            )
          : await this.retrievalService.search(searchQuestion, dto.filters);

      /**
       * 게이트 ① 거리 (docs/specs/28) — **후보 최소 거리만 본다.** 통과하면 나머지에 컷 밖
       * 청크가 있어도 유지한다: per-chunk 필터는 실측에서 top-5 정답 청크를 잘랐다(spec 28).
       * 거리 기권이면 리랭커는 호출되지 않는다 — 확실히 먼 질문에 리랭크 비용을 쓰지 않는다.
       *
       * 하이브리드에서는 첫 행이 최소 거리가 아닐 수 있다(융합 순서는 RRF다). 최소값은 벡터 arm
       * top-1과 같으므로(전 코퍼스 최소) 이 판정은 §28과 같은 의미를 유지한다.
       */
      const minDistance = retrieved.reduce(
        (min, row) => Math.min(min, row.distance),
        Number.POSITIVE_INFINITY,
      );
      let abstainReason: AbstainReason | null =
        retrieved.length === 0
          ? 'no_candidates'
          : minDistance > this.retrievalService.distanceCutoff
            ? 'beyond_cutoff'
            : null;

      /**
       * 게이트 ② 리랭크 → ③ 점수 (docs/specs/29). 실패는 검색 순위 폴백이다 —
       * 리랭커는 품질 향상 계층이지 가용성 의존성이 아니다. 점수 기권은 거리 기권과
       * 같은 사유(beyond_cutoff)로 통합한다: 사용자에게는 「관련 근거를 찾지 못했다」는
       * 같은 사실이고, 내부 원인은 로그가 구분한다.
       */
      let evidenceRows = retrieved.slice(0, RETRIEVAL_TOP_K);
      let retrievalPolicyVersion = hybridActive
        ? this.retrievalService.hybridPolicyVersion()
        : this.retrievalService.policyVersion;
      if (!abstainReason && rerankActive) {
        const rerankStartedAt = process.hrtime.bigint();
        const elapsedSec = (): number =>
          Number(process.hrtime.bigint() - rerankStartedAt) / 1e9;
        try {
          const result = await this.reranker.rerank(
            dto.content,
            retrieved.map((row) => ({
              chunkId: row.chunk.id,
              content: row.chunk.content,
              guidelineTitle: row.guideline.title,
            })),
          );
          this.metrics.recordRerank('reranked', elapsedSec());
          if (result.top1Relevance < this.retrievalService.rerankScoreCutoff) {
            abstainReason = 'beyond_cutoff';
          } else {
            const byChunkId = new Map(retrieved.map((row) => [row.chunk.id, row]));
            const reranked = result.order
              .map((chunkId) => byChunkId.get(chunkId))
              .filter((row): row is RetrievedEvidence => row !== undefined)
              .slice(0, RETRIEVAL_TOP_K);
            if (reranked.length > 0) {
              evidenceRows = reranked;
              retrievalPolicyVersion = hybridActive
                ? this.retrievalService.hybridPolicyVersion(this.reranker.model)
                : this.retrievalService.rerankedPolicyVersion(this.reranker.model);
            }
          }
        } catch (error) {
          this.metrics.recordRerank('fallback', elapsedSec());
          this.logger.warn(`[${traceId}] 리랭크 실패 — 코사인 순위 폴백: ${String(error)}`);
        }
      }

      /**
       * 근거 상세에 번역을 붙인다 (docs/specs/42 기준 12b). 한국어 경로는 조회 자체를 건너뛰어
       * 오늘과 같은 질의 수를 유지한다 — 번역 기능이 한국어 사용자의 지연을 늘리지 않는다.
       */
      const chunkTranslations =
        abstainReason || responseLang === 'ko'
          ? new Map()
          : await this.repository.mapChunkTranslations(
              evidenceRows.map((row) => row.chunk.id),
              responseLang,
            );

      sse.send({
        eventType: 'retrieval.completed',
        evidence: abstainReason
          ? []
          : evidenceRows.map((row) =>
              toEvidenceDetail(
                { ...row, translation: chunkTranslations.get(row.chunk.id) ?? null },
                responseLang,
              ),
            ),
      });

      if (abstainReason) {
        ragOutcome = 'abstained';
        this.metrics.recordAbstain(abstainReason);
        await this.repository.updateMessage(assistantMessageId, {
          status: 'ABSTAINED',
          content: '',
        });
        const message = await this.loadMessageDto(assistantMessageId, principal);
        sse.send({
          eventType: 'answer.abstained',
          message,
          reason: ABSTAIN_REASON_MESSAGE[responseLang][abstainReason],
          missingInformation: [],
        });
        return;
      }

      // PATIENT_GUIDANCE: 생성 직전 프로필을 immutable 스냅샷으로 고정하고 (§4.5, §9)
      // 복호화 프로필을 LLM 질문 컨텍스트에 합성한다. abstain 경로는 위에서 이미 이탈했다
      let guidanceContext: GuidanceContext | null = null;
      let question = dto.content;
      if (conversation.type === 'PATIENT_GUIDANCE') {
        if (!conversation.patientId) throw new ServiceException('INTERNAL_ERROR');
        const captured = await this.patientSnapshotService.captureWithProfile(
          { clinicId: principal.clinicId },
          conversation.patientId,
        );
        guidanceContext = {
          patientId: conversation.patientId,
          snapshotId: captured.snapshotId,
          profile: captured.payload,
        };
        question = composeGuidanceQuestion(captured.payload, dto.content);
      }

      // 게이트 ④ 생성 (docs/specs/40) — 발화하면 답변이 아니라 기권으로 끝난다
      ragOutcome = await this.generateAnswer({
        sse,
        principal,
        retrieved: evidenceRows,
        retrievalPolicyVersion,
        question,
        assistantMessageId,
        clientSignal,
        traceId,
        guidanceContext,
        responseLang,
        originalQuestion: dto.content,
        searchQuestion,
      });
    } catch (error) {
      sseOutcome = clientSignal.aborted ? 'aborted' : 'failed';
      // 사용자가 끊은 것은 답변 실패가 아니다 — sse_streams_total{outcome="aborted"}가 이미 센다.
      // 여기서 failed로 세면 실패율이 사용자 이탈로 오염되어 장애 판단을 흐린다.
      ragOutcome = clientSignal.aborted ? null : 'failed';
      await this.handleStreamFailure(error, assistantMessageId, clientSignal, sse, traceId);
    } finally {
      sse.end();
      this.metrics.sseStreamEnded(sseOutcome);
      if (ragOutcome !== null) this.metrics.recordAnswerOutcome(ragOutcome);
    }
  }

  private async generateAnswer(args: {
    sse: SseStream;
    principal: ClinicianPrincipal;
    retrieved: RetrievedEvidence[];
    /** 이 답변이 실제로 탄 검색 정책 — 리랭크 성공 v3, 폴백·비활성 v2 (docs/specs/29 기준 7) */
    retrievalPolicyVersion: string;
    question: string;
    assistantMessageId: string;
    clientSignal: AbortSignal;
    traceId: string;
    guidanceContext: GuidanceContext | null;
    /** 답변을 쓸 언어 (docs/specs/42) — 프롬프트 규칙 5와 promptVersion을 가른다 */
    responseLang: SupportedLang;
    /** 사용자가 보낸 원문 질의 — 번역 경로에서 searchQuestion과 갈린다 (기준 6a) */
    originalQuestion: string;
    /** 실제로 검색에 넣은 문자열 — 언제나 한국어다 (기준 6b) */
    searchQuestion: string;
    /** 답변으로 끝났는지 생성 게이트로 기권했는지 — 호출자가 rag_answers_total에 반영한다 */
  }): Promise<'answered' | 'abstained'> {
    const { sse, retrieved, question, assistantMessageId, clientSignal, traceId } = args;

    const evidenceContext: LlmEvidenceContext[] = retrieved.map((row, index) => ({
      marker: index + 1,
      content: row.chunk.content,
      guidelineTitle: row.guideline.title,
      sectionPath: row.section.path,
    }));

    let seq = 0;
    const timeoutSignal = AbortSignal.timeout(STREAM_TIMEOUT_MS);
    const signal = AbortSignal.any([clientSignal, timeoutSignal]);
    let outcome;
    try {
      outcome = await this.llmGateway.stream(
        { question, evidence: evidenceContext, signal, responseLang: args.responseLang },
        (delta) => {
          sse.send({ eventType: 'answer.delta', messageId: assistantMessageId, seq, delta });
          seq += 1;
        },
      );
    } catch (error) {
      // 전체 상한 초과를 프로바이더 장애와 구분한다. 클라이언트 abort가 함께 걸린 경우는
      // CANCELLED가 우선이므로(§8-4) 상위 handleStreamFailure의 판정을 가로채지 않는다.
      if (timeoutSignal.aborted && !clientSignal.aborted) throw new StreamTimeoutError();
      throw error;
    }

    /**
     * 게이트 ④ 생성 (docs/specs/40).
     *
     * ①~③이 「이 근거가 질문과 관련 있는가」를 쟀다면 여기는 「이 근거로 답할 수 있는가」다.
     * 둘은 갈린다 — 군발두통 질문에 편두통 청크가 리랭커 관련도 10.0을 받은 실례가 있다.
     * 답변가능성은 근거 전문을 보고 답을 써 보는 쪽만 판단할 수 있으므로 생성기가 낸다.
     * 새 판단을 만드는 것이 아니라, 이미 산문으로 내려지고 버려지던 판단의 승격이다.
     */
    if (outcome.verdict?.insufficientEvidence) {
      await this.abstainOnGeneration({
        sse,
        principal: args.principal,
        assistantMessageId,
        question,
        missingAspects: outcome.verdict.missingAspects,
        outcome,
        retrievalPolicyVersion: args.retrievalPolicyVersion,
        traceId,
        responseLang: args.responseLang,
        originalQuestion: args.originalQuestion,
        searchQuestion: args.searchQuestion,
      });
      return 'abstained';
    }

    // 답변에 실제 등장한 마커만 인용으로 영속화
    const usedMarkers = new Set(
      [...outcome.text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])),
    );
    const citationRows = retrieved
      .map((row, index) => ({ row, marker: index + 1 }))
      .filter(({ marker }) => usedMarkers.has(marker))
      .map(({ row, marker }) => ({
        id: ulid(),
        messageId: assistantMessageId,
        evidenceChunkId: row.chunk.id,
        marker,
        quote: truncate(row.chunk.content, QUOTE_LIMIT),
      }));

    // 구조화는 영속화 tx **밖**에서 한다 — 외부 호출을 tx 안에 두면 커넥션을 상한(20s)만큼 붙잡는다
    const structuring = args.guidanceContext
      ? await this.structureGuidance({
          guidanceContext: args.guidanceContext,
          retrieved,
          usedMarkers,
          answerText: outcome.text,
          clientSignal,
          traceId,
        })
      : null;

    let guidance: ClinicalGuidanceResponseDto | null = null;
    let composerVersion: string | null = null;
    await this.txManager.run(async () => {
      await this.repository.updateMessage(assistantMessageId, {
        content: outcome.text,
        status: 'COMPLETED',
      });
      await this.repository.insertCitations(citationRows);
      await this.repository.insertGenerationRun({
        id: ulid(),
        messageId: assistantMessageId,
        provider: outcome.provider,
        model: outcome.model ?? MODEL_LABEL,
        promptVersion: promptVersionFor(args.responseLang),
        originalQuestion: args.originalQuestion,
        searchQuestion: args.searchQuestion,
        retrievalPolicyVersion: args.retrievalPolicyVersion,
        latencyMs: outcome.latencyMs,
        tokenUsage: {
          inputTokens: estimateTokens(question),
          outputTokens: estimateTokens(outcome.text),
        },
        traceId,
      });

      // 가이던스 행은 답변 영속화와 같은 tx에서 생성 — 부분 커밋으로 답변만 남는 상태를 막는다
      if (args.guidanceContext) {
        const citationDetails = await this.repository.listCitationDetails(
          [assistantMessageId],
          args.responseLang,
        );
        const composed = await this.guidanceComposer.compose({
          messageId: assistantMessageId,
          patientId: args.guidanceContext.patientId,
          patientSnapshotId: args.guidanceContext.snapshotId,
          clinicId: args.principal.clinicId,
          answerText: outcome.text,
          citations: citationDetails.map((row) => toCitationDto(row, args.responseLang)),
          profile: args.guidanceContext.profile,
          structured: structuring?.structured ?? null,
        });
        guidance = composed.guidance;
        composerVersion = composed.composerVersion;
      }
    });

    // 채택 여부는 조립이 끝나야 정해진다 — 구조화가 성공해도 검증이 전멸하면 폴백이다
    if (structuring) {
      this.metrics.recordGuidanceCompose(
        structuring.skipped ??
          (composerVersion === GUIDANCE_PROMPT_VERSION ? 'structured' : 'fallback'),
        structuring.durationSec,
      );
    }

    const message = await this.loadMessageDto(assistantMessageId, args.principal);
    // GUIDELINE_QA 완료 이벤트에는 guidance 속성 자체가 없어야 한다 (spec 10 기준 5)
    if (guidance) {
      sse.send({ eventType: 'answer.completed', message, guidance });
    } else {
      sse.send({ eventType: 'answer.completed', message });
    }
    return 'answered';
  }

  /**
   * 생성 게이트 발화의 종결 처리 (docs/specs/40).
   *
   * 답변 텍스트도 인용도 남기지 않는다 — 「무관 근거를 인용한 거부」가 프로덕션에서 실제로
   * 영속화된 적이 있다(만성 아토피 사례, 무관 인용 5건). 반면 **GenerationRun은 기록한다**:
   * 검색 게이트와 달리 여기는 LLM을 부르고 토큰을 썼고, 과잉 기권을 사후에 문항 단위로
   * 조사하려면 「어느 프롬프트·어느 검색 정책에서 발화했나」가 남아 있어야 한다.
   * 덤으로 「ABSTAINED + run 있음 = 생성 게이트 / run 없음 = 검색 게이트」라는 자기서술적
   * 불변식이 생긴다.
   */
  private async abstainOnGeneration(args: {
    responseLang: SupportedLang;
    originalQuestion: string;
    searchQuestion: string;
    sse: SseStream;
    principal: ClinicianPrincipal;
    assistantMessageId: string;
    question: string;
    missingAspects: string[];
    outcome: LlmStreamOutcome;
    retrievalPolicyVersion: string;
    traceId: string;
  }): Promise<void> {
    const { assistantMessageId, outcome } = args;

    // 사용자에게는 같은 사실이라 문구가 같고, 원인 구분은 내부 축이다 —
    // 빈 축의 재호출·무효화를 지금 고르지 않는 이유는 원인이 아직 구분되지 않았기 때문이다
    this.metrics.recordGenerationGate(
      args.missingAspects.length > 0 ? 'model_verdict' : 'empty_aspects',
    );

    await this.txManager.run(async () => {
      await this.repository.updateMessage(assistantMessageId, {
        content: '',
        status: 'ABSTAINED',
      });
      await this.repository.insertGenerationRun({
        id: ulid(),
        messageId: assistantMessageId,
        provider: outcome.provider,
        model: outcome.model ?? MODEL_LABEL,
        promptVersion: promptVersionFor(args.responseLang),
        originalQuestion: args.originalQuestion,
        searchQuestion: args.searchQuestion,
        retrievalPolicyVersion: args.retrievalPolicyVersion,
        latencyMs: outcome.latencyMs,
        // 출력 토큰은 판정뿐이다 — 본문은 생성되지 않았거나 게이트웨이가 닫았다
        tokenUsage: { inputTokens: estimateTokens(args.question), outputTokens: 0 },
        traceId: args.traceId,
      });
    });

    const message = await this.loadMessageDto(assistantMessageId, args.principal);
    args.sse.send({
      eventType: 'answer.abstained',
      message,
      reason: ABSTAIN_REASON_MESSAGE[args.responseLang].insufficient_evidence,
      // missingAspects는 내부 관측 축이다 — 계약에 실으면 렌더 여부를 이 스펙 밖에서 정하게
      // 되고, missingInformation은 §7이 환자 프로필 필드명으로 못박은 다른 어휘다
      missingInformation: [],
    });
  }

  /**
   * 답변이 **실제로 인용한** 청크 원문과 환자 프로필로 참고안을 구조화한다 (docs/specs/33).
   * 새 검색도 새 근거도 없다 — 두 다리 모두 이미 이 요청 안에 있던 것이다.
   * 인용이 0건이면 근거 다리를 세울 수 없으므로 호출 자체를 생략한다.
   */
  private async structureGuidance(args: {
    guidanceContext: GuidanceContext;
    retrieved: RetrievedEvidence[];
    usedMarkers: Set<number>;
    answerText: string;
    clientSignal: AbortSignal;
    traceId: string;
  }): Promise<{
    structured: GuidanceStructureResult | null;
    /** 구조화기를 부르지 않은 사유 — 실제로 호출했으면 null */
    skipped: 'disabled' | 'skipped' | null;
    durationSec: number | null;
  }> {
    // 킬스위치 (docs/specs/33 기준 8) — 근거를 모으기도 전에 빠진다
    if (this.guidanceStructurer.disabled === true) {
      return { structured: null, skipped: 'disabled', durationSec: null };
    }

    const evidence: GuidanceEvidenceContext[] = args.retrieved
      .map((row, index) => ({ row, marker: index + 1 }))
      .filter(({ marker }) => args.usedMarkers.has(marker))
      .map(({ row, marker }) => ({
        marker,
        // quote 발췌가 아니라 청크 원문이다 — 조건·금기는 발췌 밖에 있는 경우가 많다
        content: row.chunk.content,
        guidelineTitle: row.guideline.title,
        sectionPath: row.section.path,
      }));
    if (evidence.length === 0) {
      return { structured: null, skipped: 'skipped', durationSec: null };
    }

    const startedAt = Date.now();
    const structured = await structureWithTimeout(
      this.guidanceStructurer,
      {
        answerText: args.answerText,
        evidence,
        profileFields: presentGuidanceProfileFields(args.guidanceContext.profile),
      },
      { signal: args.clientSignal },
    );
    if (!structured) {
      this.logger.warn(`[${args.traceId}] 참고안 구조화 실패·상한 초과 — 결정적 조립으로 폴백`);
    }
    return { structured, skipped: null, durationSec: (Date.now() - startedAt) / 1000 };
  }

  private async handleStreamFailure(
    error: unknown,
    assistantMessageId: string,
    clientSignal: AbortSignal,
    sse: SseStream,
    traceId: string,
  ): Promise<void> {
    if (clientSignal.aborted) {
      // §8-4: 클라이언트 abort → CANCELLED 정리 (이벤트는 보낼 수 없다)
      await this.repository.updateMessageIfStreaming(assistantMessageId, 'CANCELLED');
      return;
    }

    const code = classifyStreamFailure(error);
    this.logger.error(`[${traceId}] 스트리밍 실패(${code}): ${String(error)}`);
    await this.repository.updateMessageIfStreaming(assistantMessageId, 'FAILED');
    sse.send({
      eventType: 'error',
      code,
      message: ErrorCodes[code].message,
      retryable: RETRYABLE_STREAM_FAILURES.has(code),
      traceId,
    });
  }

  private async loadMessageDto(messageId: string, principal: ClinicianPrincipal) {
    const found = await this.repository.findMessageInScope(
      { clinicId: principal.clinicId },
      messageId,
    );
    if (!found) throw new ServiceException('INTERNAL_ERROR');
    // 재조회의 언어는 요청이 아니라 **그 메시지가 생성될 때의 언어**다 (docs/specs/42 기준 11)
    const lang = ((found.message as MessageRow).responseLang ?? 'ko') as SupportedLang;
    const citations = await this.repository.listCitationDetails([messageId], lang);
    return toMessageDto(
      found.message as MessageRow,
      citations.map((row) => toCitationDto(row, lang)),
    );
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
