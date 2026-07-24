import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { decodeCursor, encodeCursor } from '../../../global/common/cursor/cursor.util';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { PageResult } from '../../../global/common/response/page-result';
import { ClinicianPrincipal } from '../../../global/security/clinician-principal';
import { CreateConversationRequestDto } from '../dto/request/create-conversation.request.dto';
import { ListConversationsQueryDto } from '../dto/request/list-conversations.query.dto';
import { ListMessagesQueryDto } from '../dto/request/list-messages.query.dto';
import { SubmitFeedbackRequestDto } from '../dto/request/submit-feedback.request.dto';
import { AnswerCitationResponseDto } from '../dto/response/answer-citation.response.dto';
import { ConversationDetailResponseDto } from '../dto/response/conversation-detail.response.dto';
import { ConversationSummaryResponseDto } from '../dto/response/conversation-summary.response.dto';
import { MessageResponseDto } from '../dto/response/message.response.dto';
import {
  toConversationDetail,
  toConversationSummary,
  toCitationDto,
  toMessageDto,
} from '../mapper/conversation.mapper';
import { ConversationRepository } from '../repository/conversation.repository';

const DEFAULT_SIZE = 20;
const DEFAULT_MESSAGE_SIZE = 50;
const DEFAULT_TITLE = '새 대화';

interface IdCursor extends Record<string, unknown> {
  id: string;
}

@Injectable()
export class ConversationService {
  constructor(private readonly repository: ConversationRepository) {}

  async create(
    principal: ClinicianPrincipal,
    dto: CreateConversationRequestDto,
  ): Promise<ConversationSummaryResponseDto> {
    // PATIENT_GUIDANCE는 9단계(Patient 도메인)에서 활성화된다 (docs/specs/06)
    if (dto.type !== 'GUIDELINE_QA') {
      throw new ServiceException('BAD_REQUEST', { reason: 'PATIENT_GUIDANCE_NOT_AVAILABLE' });
    }

    const id = ulid();
    await this.repository.insertConversation({
      id,
      clinicianId: principal.clinicianId,
      clinicId: principal.clinicId,
      type: dto.type,
      patientId: null,
      title: dto.title ?? DEFAULT_TITLE,
    });

    const row = await this.repository.findById({ clinicianId: principal.clinicianId }, id);
    if (!row) throw new ServiceException('INTERNAL_ERROR');
    return toConversationSummary(row);
  }

  async list(
    principal: ClinicianPrincipal,
    query: ListConversationsQueryDto,
  ): Promise<PageResult<ConversationSummaryResponseDto>> {
    const size = query.size ?? DEFAULT_SIZE;
    const afterId = query.cursor ? decodeCursor<IdCursor>(query.cursor).id : undefined;

    const rows = await this.repository.list(
      { clinicianId: principal.clinicianId },
      { type: query.type, patientId: query.patientId, afterId, limit: size + 1 },
    );
    const hasNext = rows.length > size;
    const page = rows.slice(0, size);
    const latest = await this.repository.latestMessages(page.map((c) => c.id));

    return PageResult.of(
      page.map((row) => toConversationSummary(row, latest.get(row.id))),
      {
        size,
        hasNext,
        nextCursor: hasNext ? encodeCursor({ id: page[page.length - 1].id }) : null,
      },
    );
  }

  async detail(
    principal: ClinicianPrincipal,
    conversationId: string,
  ): Promise<ConversationDetailResponseDto> {
    const row = await this.repository.findById(
      { clinicianId: principal.clinicianId },
      conversationId,
    );
    if (!row) throw new ServiceException('NOT_FOUND');
    const latest = await this.repository.latestMessages([row.id]);
    return toConversationDetail(row, latest.get(row.id));
  }

  async listMessages(
    principal: ClinicianPrincipal,
    conversationId: string,
    query: ListMessagesQueryDto,
  ): Promise<PageResult<MessageResponseDto>> {
    const conversation = await this.repository.findById(
      { clinicianId: principal.clinicianId },
      conversationId,
    );
    if (!conversation) throw new ServiceException('NOT_FOUND');

    const size = query.size ?? DEFAULT_MESSAGE_SIZE;
    const afterId = query.cursor ? decodeCursor<IdCursor>(query.cursor).id : undefined;

    const rows = await this.repository.listMessages(conversationId, {
      afterId,
      limit: size + 1,
    });
    const hasNext = rows.length > size;
    const page = rows.slice(0, size);

    const citationRows = await this.repository.listCitationDetails(page.map((m) => m.id));
    const citationsByMessage = new Map<string, AnswerCitationResponseDto[]>();
    for (const row of citationRows) {
      const list = citationsByMessage.get(row.citation.messageId) ?? [];
      list.push(toCitationDto(row));
      citationsByMessage.set(row.citation.messageId, list);
    }

    return PageResult.of(
      page.map((row) => toMessageDto(row, citationsByMessage.get(row.id) ?? [])),
      {
        size,
        hasNext,
        nextCursor: hasNext ? encodeCursor({ id: page[page.length - 1].id }) : null,
      },
    );
  }

  async submitFeedback(
    principal: ClinicianPrincipal,
    messageId: string,
    dto: SubmitFeedbackRequestDto,
  ): Promise<null> {
    const found = await this.repository.findMessageInScope(
      { clinicianId: principal.clinicianId },
      messageId,
    );
    if (!found) throw new ServiceException('NOT_FOUND');

    await this.repository.upsertFeedback({
      id: ulid(),
      messageId,
      clinicianId: principal.clinicianId,
      rating: dto.rating,
      reasonCodes: dto.reasonCodes ?? null,
      comment: dto.comment ?? null,
    });
    return null;
  }
}
