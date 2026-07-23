import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, lt } from 'drizzle-orm';
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

  async list(
    scope: ConversationScope,
    filter: { type?: ConversationRow['type']; patientId?: string; afterId?: string; limit: number },
  ): Promise<ConversationRow[]> {
    const conditions = [
      eq(conversations.clinicianId, scope.clinicianId),
      filter.type ? eq(conversations.type, filter.type) : undefined,
      filter.patientId ? eq(conversations.patientId, filter.patientId) : undefined,
      filter.afterId ? lt(conversations.id, filter.afterId) : undefined,
    ].filter((c) => c !== undefined);

    return this.txManager.conn
      .select()
      .from(conversations)
      .where(and(...conditions))
      .orderBy(desc(conversations.id))
      .limit(filter.limit);
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
    filter: { afterId?: string; limit: number },
  ): Promise<MessageRow[]> {
    const conditions = [
      eq(messages.conversationId, conversationId),
      filter.afterId ? gt(messages.id, filter.afterId) : undefined,
    ].filter((c) => c !== undefined);

    return this.txManager.conn
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(asc(messages.id))
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
