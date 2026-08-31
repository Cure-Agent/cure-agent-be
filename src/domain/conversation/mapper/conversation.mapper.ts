import { AnswerCitationResponseDto } from '../dto/response/answer-citation.response.dto';
import { ConversationDetailResponseDto } from '../dto/response/conversation-detail.response.dto';
import { ConversationSummaryResponseDto } from '../dto/response/conversation-summary.response.dto';
import { MessageResponseDto } from '../dto/response/message.response.dto';
import { ConversationRow, MessageRow } from '../persistence/conversation.schema';
import { CitationDetailRow } from '../repository/conversation.repository';
import { SupportedLang } from '../../../infrastructure/llm/translation/translator.port';
import { AbstainReason } from '../../../global/observability/metrics/metrics.service';
import { usableTranslation } from '../../guideline/mapper/translation.util';

const PREVIEW_LIMIT = 80;

/**
 * 기권 사유별 사용자 문구 (docs/specs/28 기준 5 · docs/specs/42 기준 26·27).
 *
 * **매퍼가 소유한다** (docs/specs/43) — 사유는 코드로 저장되고 문장은 직렬화 시점에 만들어지므로,
 * 문구표는 그 렌더가 일어나는 곳에 있어야 한다. SSE `answer.abstained`의 `reason`도 같은 표를
 * 읽어 스트림과 재조회의 문장이 갈릴 수 없다.
 *
 * 사유가 다르면 **다르게 읽혀야** 재질의를 유도한다 — 세 문장을 하나로 합치지 않는다.
 * `reasonCode`를 노출해 FE로 옮기는 안은 §42 판단표가 미뤘고 §43이 그 결정을 유지한다.
 */
export const ABSTAIN_REASON_MESSAGE: Record<SupportedLang, Record<AbstainReason, string>> = {
  ko: {
    no_candidates: '검색 조건에 해당하는 지침 근거를 찾지 못했습니다.',
    beyond_cutoff: '질문과 충분히 관련된 지침 근거를 찾지 못했습니다.',
    // 생성 게이트 (docs/specs/40) — 위 둘과 달리 「근거는 찾았으나 그것으로 답할 수 없다」다.
    // 재질의 방향이 다르므로(질문을 좁히는 쪽) 문구를 합치지 않는다.
    insufficient_evidence: '찾은 지침 근거만으로는 이 질문에 답하기 어렵습니다.',
  },
  en: {
    no_candidates: 'No guideline evidence matched the selected search filters.',
    beyond_cutoff: 'No guideline evidence was closely enough related to this question.',
    insufficient_evidence:
      'The guideline evidence found is not sufficient to answer this question.',
  },
};

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
          // 저장된 인용도 펼침 헤더를 그린다 (docs/specs/44 기준 12) — 세 경로 가운데
          // 하나라도 비면 그 화면만 한국어 경로가 남는다
          ...(translation.sectionPathTranslated
            ? { sectionPathTranslated: translation.sectionPathTranslated }
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
    // 화면 표시 언어의 원천 (docs/specs/44 기준 23·24) — 재조회에는 질의도 요청 언어도
    // 실리지 않으므로 이 값 없이는 대화 목록에 갔다 온 화면이 메시지의 언어를 알 수 없다.
    // 컬럼 기본값이 'ko'라 언어를 보내지 않고 만든 과거 행도 스스로를 말한다(§42 기준 3 계승).
    responseLang: (row.responseLang ?? 'ko') as SupportedLang,
    // 기권 사유는 코드로 저장되고 문장은 **여기서** 만들어진다 (docs/specs/43).
    // 읽는 시점의 언어는 요청이 아니라 그 메시지가 생성될 때의 언어다(§42 `response_lang`) —
    // 재조회에는 언어가 실리지 않으므로 이 컬럼이 유일한 축이다.
    // 사유가 없으면(기록되기 전에 만들어진 과거 행) **키 자체를 싣지 않는다** — 빈 문자열을
    // 실으면 화면이 빈 안내를 그린다. §42가 stale 번역에 쓴 규율과 같다.
    ...(row.abstainReason
      ? {
          abstainReason:
            ABSTAIN_REASON_MESSAGE[(row.responseLang ?? 'ko') as SupportedLang][
              row.abstainReason
            ],
        }
      : {}),
    citations,
    createdAt: row.createdAt.toISOString(),
  };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
