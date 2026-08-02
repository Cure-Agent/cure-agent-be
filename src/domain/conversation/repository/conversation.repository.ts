import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, gt, ilike, inArray, lt, sql } from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import {
  GuidelineRow,
  GuidelineSectionRow,
  GuidelineVersionRow,
  evidenceChunks,
  guidelineSections,
  guidelineVersions,
  guidelines,
} from '../../guideline/persistence/guideline.schema';
import {
  ConversationRow,
  MessageCitationRow,
  MessageRow,
  answerFeedbacks,
  conversations,
  generationRuns,
  messageCitations,
  messages,
} from '../persistence/conversation.schema';

/** §4.4 — conversation 계열 조회·변경은 clinician 스코프 필수 */
export interface ConversationScope {
  clinicianId: string;
}

export interface CitationDetailRow {
  citation: MessageCitationRow;
  section: GuidelineSectionRow;
  version: GuidelineVersionRow;
  guideline: GuidelineRow;
}

/**
 * 커서에 실을 정렬 키 원본. updatedAt을 Date로 받으면 pg 드라이버가 마이크로초를 버려서,
 * 같은 밀리초 안에 있는 대화가 페이지 경계에서 통째로 건너뛰어진다 — 문자열로 그대로 실어 나른다.
 */
const CURSOR_UPDATED_AT = sql<string>`to_char(${conversations.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export type ConversationListRow = ConversationRow & { cursorUpdatedAt: string };

@Injectable()
export class ConversationRepository {
  constructor(private readonly txManager: TransactionManager) {}

  // ── conversations ────────────────────────────────────

  async insertConversation(
    row: Pick<ConversationRow, 'id' | 'clinicianId' | 'clinicId' | 'type' | 'patientId' | 'title'>,
  ): Promise<void> {
    await this.txManager.conn.insert(conversations).values(row);
  }

  async findById(scope: ConversationScope, id: string): Promise<ConversationRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.clinicianId, scope.clinicianId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 최근 대화순(updated_at desc) — 메시지를 주고받은 대화가 맨 앞으로 온다(touchConversation).
   * id는 동시각 타이브레이크이자 keyset의 유일성 보장이다. 커서는 두 값을 묶은 행 비교로
   * 끊어 idx_conversations_clinician_recent 역방향 스캔에 그대로 태운다.
   */
  async list(
    scope: ConversationScope,
    filter: {
      type?: ConversationRow['type'];
      patientId?: string;
      status?: ConversationRow['status'];
      query?: string;
      after?: { updatedAt: string; id: string };
      limit: number;
    },
  ): Promise<ConversationListRow[]> {
    const conditions = [
      eq(conversations.clinicianId, scope.clinicianId),
      filter.type ? eq(conversations.type, filter.type) : undefined,
      filter.patientId ? eq(conversations.patientId, filter.patientId) : undefined,
      filter.status ? eq(conversations.status, filter.status) : undefined,
      filter.query ? ilike(conversations.title, `%${filter.query}%`) : undefined,
      filter.after
        ? sql`(${conversations.updatedAt}, ${conversations.id}) < (${filter.after.updatedAt}::timestamptz, ${filter.after.id})`
        : undefined,
    ].filter((c) => c !== undefined);

    return this.txManager.conn
      .select({ ...getTableColumns(conversations), cursorUpdatedAt: CURSOR_UPDATED_AT })
      .from(conversations)
      .where(and(...conditions))
      .orderBy(desc(conversations.updatedAt), desc(conversations.id))
      .limit(filter.limit);
  }

  /**
   * 메시지 활동으로 대화를 최신으로 끌어올린다 (목록 정렬 키).
   * 소유 검증은 호출부(stream 진입 시 findById)가 이미 마쳤다.
   * now()로 쓰는 이유: 생성 시각이 defaultNow()(DB 시계·마이크로초)라, $onUpdate의
   * 앱 시계 밀리초 값을 섞으면 방금 만든 대화가 touch 뒤에 오히려 뒤로 밀릴 수 있다.
   */
  async touchConversation(id: string): Promise<void> {
    await this.txManager.conn
      .update(conversations)
      .set({ updatedAt: sql`now()` })
      .where(eq(conversations.id, id));
  }

  /** 소유 스코프에서만 갱신 — 0행이면 미존재/타인 (docs/specs/11) */
  async updateTitle(
    scope: ConversationScope,
    id: string,
    title: string,
  ): Promise<ConversationRow | null> {
    const rows = await this.txManager.conn
      .update(conversations)
      .set({ title })
      .where(and(eq(conversations.id, id), eq(conversations.clinicianId, scope.clinicianId)))
      .returning();
    return rows[0] ?? null;
  }

  /** 멱등 — 이미 해당 상태여도 갱신으로 취급한다 (docs/specs/11 기준 2) */
  async updateStatus(
    scope: ConversationScope,
    id: string,
    status: ConversationRow['status'],
  ): Promise<ConversationRow | null> {
    const rows = await this.txManager.conn
      .update(conversations)
      .set({ status })
      .where(and(eq(conversations.id, id), eq(conversations.clinicianId, scope.clinicianId)))
      .returning();
    return rows[0] ?? null;
  }

  // ── messages ─────────────────────────────────────────

  async insertMessage(
    row: Pick<
      MessageRow,
      'id' | 'conversationId' | 'role' | 'content' | 'status' | 'answerKind' | 'clientRequestId'
    >,
  ): Promise<void> {
    await this.txManager.conn.insert(messages).values(row);
  }

  async existsByClientRequestId(clientRequestId: string): Promise<boolean> {
    const rows = await this.txManager.conn
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.clientRequestId, clientRequestId))
      .limit(1);
    return rows.length > 0;
  }

  async listMessages(
    conversationId: string,
    filter: { afterId?: string; beforeId?: string; order?: 'asc' | 'desc'; limit: number },
  ): Promise<MessageRow[]> {
    const conditions = [
      eq(messages.conversationId, conversationId),
      filter.afterId ? gt(messages.id, filter.afterId) : undefined,
      filter.beforeId ? lt(messages.id, filter.beforeId) : undefined,
    ].filter((c) => c !== undefined);

    return this.txManager.conn
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(filter.order === 'desc' ? desc(messages.id) : asc(messages.id))
      .limit(filter.limit);
  }

  /** 대화별 최신 메시지 (목록 미리보기용) */
  async latestMessages(conversationIds: string[]): Promise<Map<string, MessageRow>> {
    if (conversationIds.length === 0) return new Map();
    const rows = await this.txManager.conn
      .select()
      .from(messages)
      .where(inArray(messages.conversationId, conversationIds))
      .orderBy(desc(messages.id));

    const latest = new Map<string, MessageRow>();
    for (const row of rows) {
      if (!latest.has(row.conversationId)) latest.set(row.conversationId, row);
    }
    return latest;
  }

  async findMessageInScope(
    scope: ConversationScope,
    messageId: string,
  ): Promise<{ message: MessageRow; conversation: ConversationRow } | null> {
    const rows = await this.txManager.conn
      .select({ message: messages, conversation: conversations })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(eq(messages.id, messageId), eq(conversations.clinicianId, scope.clinicianId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async updateMessage(
    id: string,
    patch: Partial<Pick<MessageRow, 'content' | 'status'>>,
  ): Promise<void> {
    await this.txManager.conn.update(messages).set(patch).where(eq(messages.id, id));
  }

  /** STREAMING 상태일 때만 갱신 (abort 경합 시 완료 상태를 덮어쓰지 않도록) */
  async updateMessageIfStreaming(id: string, status: MessageRow['status']): Promise<void> {
    await this.txManager.conn
      .update(messages)
      .set({ status })
      .where(and(eq(messages.id, id), eq(messages.status, 'STREAMING')));
  }

  // ── citations / runs / feedback ──────────────────────

  async insertCitations(
    rows: Pick<MessageCitationRow, 'id' | 'messageId' | 'evidenceChunkId' | 'marker' | 'quote'>[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.txManager.conn.insert(messageCitations).values(rows);
  }

  async listCitationDetails(messageIds: string[]): Promise<CitationDetailRow[]> {
    if (messageIds.length === 0) return [];
    return this.txManager.conn
      .select({
        citation: messageCitations,
        section: guidelineSections,
        version: guidelineVersions,
        guideline: guidelines,
      })
      .from(messageCitations)
      .innerJoin(evidenceChunks, eq(messageCitations.evidenceChunkId, evidenceChunks.id))
      .innerJoin(guidelineSections, eq(evidenceChunks.sectionId, guidelineSections.id))
      .innerJoin(guidelineVersions, eq(evidenceChunks.guidelineVersionId, guidelineVersions.id))
      .innerJoin(guidelines, eq(guidelineVersions.guidelineId, guidelines.id))
      .where(inArray(messageCitations.messageId, messageIds))
      .orderBy(asc(messageCitations.marker));
  }

  async insertGenerationRun(row: typeof generationRuns.$inferInsert): Promise<void> {
    await this.txManager.conn.insert(generationRuns).values(row);
  }

  async upsertFeedback(row: typeof answerFeedbacks.$inferInsert): Promise<void> {
    await this.txManager.conn
      .insert(answerFeedbacks)
      .values(row)
      .onConflictDoUpdate({
        target: [answerFeedbacks.messageId, answerFeedbacks.clinicianId],
        set: {
          rating: row.rating,
          reasonCodes: row.reasonCodes ?? null,
          comment: row.comment ?? null,
        },
      });
  }
}
