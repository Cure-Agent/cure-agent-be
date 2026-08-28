import { AnswerCitationResponseDto } from '../dto/response/answer-citation.response.dto';
import { ConversationDetailResponseDto } from '../dto/response/conversation-detail.response.dto';
import { ConversationSummaryResponseDto } from '../dto/response/conversation-summary.response.dto';
import { MessageResponseDto } from '../dto/response/message.response.dto';
import { ConversationRow, MessageRow } from '../persistence/conversation.schema';
import { CitationDetailRow } from '../repository/conversation.repository';

const PREVIEW_LIMIT = 80;

export function toConversationSummary(
  row: ConversationRow,
  lastMessage?: MessageRow,
): ConversationSummaryResponseDto {
  return {
    id: row.id,
    type: row.type,
    // GUIDELINE_QA는 null이라 필드 자체가 응답에서 빠진다 — 기존 소비자의 형태가 그대로 유지된다
    patientId: row.patientId ?? undefined,
    title: row.title,
    status: row.status,
    lastMessagePreview: lastMessage ? truncate(lastMessage.content, PREVIEW_LIMIT) : undefined,
    lastMessageAt: row.lastMessageAt.toISOString(),
  };
}

export function toConversationDetail(
  row: ConversationRow,
  lastMessage?: MessageRow,
): ConversationDetailResponseDto {
  return {
    ...toConversationSummary(row, lastMessage),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toCitationDto(row: CitationDetailRow): AnswerCitationResponseDto {
  return {
    marker: row.citation.marker,
    evidenceId: row.citation.evidenceChunkId,
    guidelineTitle: row.guideline.title,
    guidelineVersion: row.version.version,
    sectionPath: row.section.path,
    quote: row.citation.quote,
    sourceUrl: row.version.sourceUrl,
  };
}

export function toMessageDto(
  row: MessageRow,
  citations: AnswerCitationResponseDto[],
  guidanceId?: string,
): MessageResponseDto {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    answerKind: row.answerKind ?? undefined,
    guidanceId,
    citations,
    createdAt: row.createdAt.toISOString(),
  };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
