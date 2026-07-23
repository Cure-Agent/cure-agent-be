import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ulid } from 'ulid';
import { monotonicUlid } from '../../../global/common/id/monotonic-ulid';
import { ErrorCodes } from '../../../global/common/exception/error-code.registry';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { TraceContext } from '../../../global/context/trace-context.service';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { LlmGateway } from '../../../infrastructure/llm/llm-gateway';
import { LlmEvidenceContext } from '../../../infrastructure/llm/llm-provider.port';
import {
  RETRIEVAL_POLICY_VERSION,
  RetrievalService,
  RetrievedEvidence,
} from '../../../infrastructure/retrieval/retrieval.service';
import { toEvidenceDetail } from '../../guideline/mapper/guideline.mapper';
import { SendMessageRequestDto } from '../dto/request/send-message.request.dto';
import { toCitationDto, toMessageDto } from '../mapper/conversation.mapper';
import { MessageRow } from '../persistence/conversation.schema';
import { ConversationRepository } from '../repository/conversation.repository';
import { SseStream } from '../sse/sse-stream';

const PROMPT_VERSION = 'qa-v1';
const MODEL_LABEL = 'gateway-routed';
const QUOTE_LIMIT = 120;
const STREAM_TIMEOUT_MS = 120_000;
const PG_UNIQUE_VIOLATION = '23505';

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
    private readonly llmGateway: LlmGateway,
    private readonly txManager: TransactionManager,
    private readonly traceContext: TraceContext,
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
      { clinicianId: principal.clinicianId },
      conversationId,
    );
    if (!conversation) throw new ServiceException('NOT_FOUND');

    if (await this.repository.existsByClientRequestId(dto.clientRequestId)) {
      throw new ServiceException('DUPLICATE_CLIENT_REQUEST');
    }

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
          answerKind: 'GUIDELINE_ANSWER',
          clientRequestId: null,
        });
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

    try {
      sse.send({
        eventType: 'message.accepted',
        requestId: dto.clientRequestId,
        userMessageId,
        assistantMessageId,
      });

      sse.send({ eventType: 'retrieval.started', requestId: dto.clientRequestId });
      const retrieved = await this.retrievalService.search(dto.content, dto.filters);
      sse.send({
        eventType: 'retrieval.completed',
        evidence: retrieved.map((row) => toEvidenceDetail(row)),
      });

      if (retrieved.length === 0) {
        await this.repository.updateMessage(assistantMessageId, {
          status: 'ABSTAINED',
          content: '',
        });
        const message = await this.loadMessageDto(assistantMessageId, principal);
        sse.send({
          eventType: 'answer.abstained',
          message,
          reason: '검색 조건에 해당하는 지침 근거를 찾지 못했습니다.',
          missingInformation: [],
        });
        return;
      }

      await this.generateAnswer({
        sse,
        principal,
        retrieved,
        question: dto.content,
        assistantMessageId,
        clientSignal,
        traceId,
      });
    } catch (error) {
      await this.handleStreamFailure(error, assistantMessageId, clientSignal, sse, traceId);
    } finally {
      sse.end();
    }
  }

  private async generateAnswer(args: {
    sse: SseStream;
    principal: ClinicianPrincipal;
    retrieved: RetrievedEvidence[];
    question: string;
    assistantMessageId: string;
    clientSignal: AbortSignal;
    traceId: string;
  }): Promise<void> {
    const { sse, retrieved, question, assistantMessageId, clientSignal, traceId } = args;

    const evidenceContext: LlmEvidenceContext[] = retrieved.map((row, index) => ({
      marker: index + 1,
      content: row.chunk.content,
      guidelineTitle: row.guideline.title,
      sectionPath: row.section.path,
    }));

    let seq = 0;
    const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(STREAM_TIMEOUT_MS)]);
    const outcome = await this.llmGateway.stream(
      { question, evidence: evidenceContext, signal },
      (delta) => {
        sse.send({ eventType: 'answer.delta', messageId: assistantMessageId, seq, delta });
        seq += 1;
      },
    );

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
        model: MODEL_LABEL,
        promptVersion: PROMPT_VERSION,
        retrievalPolicyVersion: RETRIEVAL_POLICY_VERSION,
        latencyMs: outcome.latencyMs,
        tokenUsage: {
          inputTokens: estimateTokens(question),
          outputTokens: estimateTokens(outcome.text),
        },
        traceId,
      });
    });

    const message = await this.loadMessageDto(assistantMessageId, args.principal);
    sse.send({ eventType: 'answer.completed', message });
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

    this.logger.error(`[${traceId}] 스트리밍 실패: ${String(error)}`);
    await this.repository.updateMessageIfStreaming(assistantMessageId, 'FAILED');
    sse.send({
      eventType: 'error',
      code: 'LLM_UNAVAILABLE',
      message: ErrorCodes.LLM_UNAVAILABLE.message,
      retryable: true,
      traceId,
    });
  }

  private async loadMessageDto(messageId: string, principal: ClinicianPrincipal) {
    const found = await this.repository.findMessageInScope(
      { clinicianId: principal.clinicianId },
      messageId,
    );
    if (!found) throw new ServiceException('INTERNAL_ERROR');
    const citations = await this.repository.listCitationDetails([messageId]);
    return toMessageDto(found.message as MessageRow, citations.map(toCitationDto));
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
