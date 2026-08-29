import { AnswerCitationResponseDto } from '../dto/response/answer-citation.response.dto';
import { ConversationDetailResponseDto } from '../dto/response/conversation-detail.response.dto';
import { ConversationSummaryResponseDto } from '../dto/response/conversation-summary.response.dto';
import { MessageResponseDto } from '../dto/response/message.response.dto';
import { ConversationRow, MessageRow } from '../persistence/conversation.schema';
import { CitationDetailRow } from '../repository/conversation.repository';
import { SupportedLang } from '../../../infrastructure/llm/translation/translator.port';
import { usableTranslation } from '../../guideline/mapper/translation.util';

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

/**
 * 영문 인용 발췌 상한 (docs/specs/42 기준 13).
 *
 * `quote`는 청크 원문의 앞 120자 기계 절단이다(conversation-stream의 QUOTE_LIMIT). 한국어
 * 120자를 영어로 옮기면 대략 두 배가 되므로, 120을 그대로 쓰면 같은 정보량이 나오지 않는다.
 */
const QUOTE_LIMIT_EN = 240;

export function toCitationDto(
  row: CitationDetailRow,
  responseLang: SupportedLang = 'ko',
): AnswerCitationResponseDto {
  // 청크가 없으면 stale을 가릴 수 없다 — 판정 불가는 「번역 없음」으로 닫는다(안전한 쪽)
  const translation = row.chunk
    ? usableTranslation(row.translation, row.chunk.contentHash, responseLang)
    : null;

  return {
    marker: row.citation.marker,
    evidenceId: row.citation.evidenceChunkId,
    guidelineTitle: row.guideline.title,
    guidelineVersion: row.version.version,
    sectionPath: row.section.path,
    // 한국어 원문은 번역 유무와 무관하게 항상 실린다 — §7의 「원문 대조 최소 집합」(기준 17)
    quote: row.citation.quote,
    ...(translation
      ? {
          quoteTranslated: truncate(translation.content, QUOTE_LIMIT_EN),
          ...(translation.titleTranslated
            ? { titleTranslated: translation.titleTranslated }
            : {}),
        }
      : {}),
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
