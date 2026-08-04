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
import { PatientService } from '../../patient/service/patient.service';
import {
  toConversationDetail,
  toConversationSummary,
  toCitationDto,
  toMessageDto,
} from '../mapper/conversation.mapper';
import { ConversationRepository } from '../repository/conversation.repository';
import { ClinicalGuidanceRepository } from '../../clinical-guidance/repository/clinical-guidance.repository';

const DEFAULT_SIZE = 20;
const DEFAULT_MESSAGE_SIZE = 50;
const DEFAULT_TITLE = '새 대화';

interface IdCursor extends Record<string, unknown> {
  id: string;
}

/** 대화 목록 커서 — 정렬 키가 (lastMessageAt, id)이므로 둘 다 실어야 경계가 유일해진다 */
interface ConversationCursor extends Record<string, unknown> {
  lastMessageAt: string;
  id: string;
}

function decodeConversationCursor(cursor: string): { lastMessageAt: string; id: string } {
  const decoded = decodeCursor<ConversationCursor>(cursor);
  // lastMessageAt은 마이크로초까지 실려 있으므로 파싱값이 아니라 원문을 그대로 넘긴다 (Date로
  // 바꾸면 정밀도가 깎여 경계가 어긋난다). Date.parse는 형식 검증에만 쓴다 —
  // 정렬 키가 바뀌기 전 발급된 구형 커서도 여기서 걸러진다.
  if (typeof decoded.id !== 'string' || Number.isNaN(Date.parse(decoded.lastMessageAt))) {
    throw new ServiceException('BAD_REQUEST', { reason: 'INVALID_CURSOR' });
  }
  return { lastMessageAt: decoded.lastMessageAt, id: decoded.id };
}

@Injectable()
export class ConversationService {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly patientService: PatientService,
    private readonly guidanceRepository: ClinicalGuidanceRepository,
  ) {}

  async create(
    principal: ClinicianPrincipal,
    dto: CreateConversationRequestDto,
  ): Promise<ConversationSummaryResponseDto> {
    let patientId: string | null = null;
    if (dto.type === 'PATIENT_GUIDANCE') {
      if (!dto.patientId) {
        throw new ServiceException('BAD_REQUEST', { reason: 'PATIENT_ID_REQUIRED' });
      }
      // 미존재·타 클리닉 환자는 NOT_FOUND (§4.4 — 클리닉 스코프)
      await this.patientService.detail({ clinicId: principal.clinicId }, dto.patientId);
      patientId = dto.patientId;
    }

    const id = ulid();
    await this.repository.insertConversation({
      id,
      clinicianId: principal.clinicianId,
      clinicId: principal.clinicId,
      type: dto.type,
      patientId,
      title: dto.title ?? DEFAULT_TITLE,
      // 생성 시 제목을 지정했다면 그건 이미 사용자 의도다 — 첫 질문 자동 제목이 덮지 않는다
      titleSource: dto.title ? 'USER' : 'DEFAULT',
    });

    const row = await this.repository.findById({ clinicId: principal.clinicId }, id);
    if (!row) throw new ServiceException('INTERNAL_ERROR');
    return toConversationSummary(row);
  }

  async list(
    principal: ClinicianPrincipal,
    query: ListConversationsQueryDto,
  ): Promise<PageResult<ConversationSummaryResponseDto>> {
    const size = query.size ?? DEFAULT_SIZE;
    const after = query.cursor ? decodeConversationCursor(query.cursor) : undefined;

    const rows = await this.repository.list(
      { clinicId: principal.clinicId },
      {
        type: query.type,
        patientId: query.patientId,
        status: query.status,
        query: query.query,
        after,
        limit: size + 1,
      },
    );
    const hasNext = rows.length > size;
    const page = rows.slice(0, size);
    const latest = await this.repository.latestMessages(page.map((c) => c.id));
    const last = page[page.length - 1];

    return PageResult.of(
      page.map((row) => toConversationSummary(row, latest.get(row.id))),
      {
        size,
        hasNext,
        nextCursor: hasNext
          ? encodeCursor({ lastMessageAt: last.cursorLastMessageAt, id: last.id })
          : null,
      },
    );
  }

  async detail(
    principal: ClinicianPrincipal,
    conversationId: string,
  ): Promise<ConversationDetailResponseDto> {
    const row = await this.repository.findById(
      { clinicId: principal.clinicId },
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
      { clinicId: principal.clinicId },
      conversationId,
    );
    if (!conversation) throw new ServiceException('NOT_FOUND');

    const size = query.size ?? DEFAULT_MESSAGE_SIZE;
    const order = query.order ?? 'asc';
    const cursorId = query.cursor ? decodeCursor<IdCursor>(query.cursor).id : undefined;

    // desc: 최신부터 역방향 — cursor는 "이 id보다 과거" 경계 (채팅 위로 무한 스크롤용)
    const rows = await this.repository.listMessages(conversationId, {
      afterId: order === 'asc' ? cursorId : undefined,
      beforeId: order === 'desc' ? cursorId : undefined,
      order,
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

    // CLINICAL_GUIDANCE 답변은 새로고침 후에도 참고안 카드를 복원할 수 있도록 guidanceId를 실어준다
    const guidanceMessageIds = page
      .filter((m) => m.answerKind === 'CLINICAL_GUIDANCE')
      .map((m) => m.id);
    const guidanceIdByMessage = await this.guidanceRepository.findIdsByMessageIds(
      { clinicId: principal.clinicId },
      guidanceMessageIds,
    );

    return PageResult.of(
      page.map((row) =>
        toMessageDto(row, citationsByMessage.get(row.id) ?? [], guidanceIdByMessage.get(row.id)),
      ),
      {
        size,
        hasNext,
        nextCursor: hasNext ? encodeCursor({ id: page[page.length - 1].id }) : null,
      },
    );
  }

  async rename(
    principal: ClinicianPrincipal,
    conversationId: string,
    title: string,
  ): Promise<ConversationSummaryResponseDto> {
    const updated = await this.repository.updateTitle(
      { clinicId: principal.clinicId },
      conversationId,
      title,
    );
    if (!updated) throw new ServiceException('NOT_FOUND');
    const latest = await this.repository.latestMessages([updated.id]);
    return toConversationSummary(updated, latest.get(updated.id));
  }

  async archive(principal: ClinicianPrincipal, conversationId: string): Promise<null> {
    const updated = await this.repository.updateStatus(
      { clinicId: principal.clinicId },
      conversationId,
      'ARCHIVED',
    );
    if (!updated) throw new ServiceException('NOT_FOUND');
    return null;
  }

  async unarchive(principal: ClinicianPrincipal, conversationId: string): Promise<null> {
    const updated = await this.repository.updateStatus(
      { clinicId: principal.clinicId },
      conversationId,
      'ACTIVE',
    );
    if (!updated) throw new ServiceException('NOT_FOUND');
    return null;
  }

  /**
   * 파기 예약 (docs/specs/34) — 멱등. 이미 삭제된 대상에 다시 와도 200이고 시각을 덮지 않는다.
   */
  async remove(principal: ClinicianPrincipal, conversationId: string): Promise<null> {
    const scope = { clinicId: principal.clinicId };
    // findById가 아니라 existsInScope로 판정한다 — findById는 「이미 지운 내 대화」와
    // 「남의 대화」를 똑같이 null로 돌려주는데, 전자는 멱등이라 200이고 후자는 404다.
    if (!(await this.repository.existsInScope(scope, conversationId))) {
      throw new ServiceException('NOT_FOUND');
    }
    // softDelete의 WHERE가 deleted_at IS NULL이라, 재삭제는 0행 갱신으로 조용히 지나간다.
    await this.repository.softDelete(scope, conversationId, new Date());
    return null;
  }

  async submitFeedback(
    principal: ClinicianPrincipal,
    messageId: string,
    dto: SubmitFeedbackRequestDto,
  ): Promise<null> {
    const found = await this.repository.findMessageInScope(
      { clinicId: principal.clinicId },
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
