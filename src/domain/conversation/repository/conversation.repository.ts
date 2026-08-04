import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  sql,
} from 'drizzle-orm';
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

/**
 * §4.4 — conversation 계열 조회·변경은 **clinic 스코프** 필수 (docs/specs/35).
 *
 * 대화는 작성자 개인 소유가 아니라 **클리닉 공유 자산**이다. 작성자(`clinicianId`)는 계속
 * 기록되지만 접근 판정에는 쓰이지 않는다 — 같은 클리닉의 구성원은 서로의 대화를 읽고 이어
 * 질문하고 지운다. 클리닉 경계는 그대로라 타 클리닉 리소스는 여전히 404다.
 */
export interface ConversationScope {
  clinicId: string;
}

export interface CitationDetailRow {
  citation: MessageCitationRow;
  section: GuidelineSectionRow;
  version: GuidelineVersionRow;
  guideline: GuidelineRow;
}

/**
 * 커서에 실을 정렬 키 원본. Date로 받으면 pg 드라이버가 마이크로초를 버려서,
 * 같은 밀리초 안에 있는 대화가 페이지 경계에서 통째로 건너뛰어진다 — 문자열로 그대로 실어 나른다.
 */
const CURSOR_LAST_MESSAGE_AT = sql<string>`to_char(${conversations.lastMessageAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export type ConversationListRow = ConversationRow & { cursorLastMessageAt: string };

@Injectable()
export class ConversationRepository {
  constructor(private readonly txManager: TransactionManager) {}

  // ── conversations ────────────────────────────────────

  async insertConversation(
    row: Pick<
      ConversationRow,
      'id' | 'clinicianId' | 'clinicId' | 'type' | 'patientId' | 'title' | 'titleSource'
    >,
  ): Promise<void> {
    await this.txManager.conn.insert(conversations).values(row);
  }

  /**
   * 상세·이름변경·보관·스트림·삭제가 모두 지나는 **단일 관문**이다. 파기 예약된 대화를 여기서
   * 걸러내면 그 아래 경로(messages·stream)가 자동으로 404가 된다 (docs/specs/34 기준 3~5).
   */
  async findById(scope: ConversationScope, id: string): Promise<ConversationRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.clinicId, scope.clinicId),
          isNull(conversations.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 최근 대화순(last_message_at desc) — 메시지를 주고받은 대화만 앞으로 온다(touchLastMessageAt).
   * id는 동시각 타이브레이크이자 keyset의 유일성 보장이다. 커서는 두 값을 묶은 행 비교로
   * 끊어 idx_conversations_clinic_last_message 역방향 스캔에 그대로 태운다 (docs/specs/35에서
   * 선두 컬럼이 clinician_id → clinic_id로 바뀌었다 — 목록이 클리닉 공유이기 때문이다).
   */
  async list(
    scope: ConversationScope,
    filter: {
      type?: ConversationRow['type'];
      patientId?: string;
      status?: ConversationRow['status'];
      query?: string;
      after?: { lastMessageAt: string; id: string };
      limit: number;
    },
  ): Promise<ConversationListRow[]> {
    const conditions = [
      eq(conversations.clinicId, scope.clinicId),
      isNull(conversations.deletedAt), // docs/specs/34 기준 2
      filter.type ? eq(conversations.type, filter.type) : undefined,
      filter.patientId ? eq(conversations.patientId, filter.patientId) : undefined,
      filter.status ? eq(conversations.status, filter.status) : undefined,
      filter.query ? ilike(conversations.title, `%${filter.query}%`) : undefined,
      filter.after
        ? sql`(${conversations.lastMessageAt}, ${conversations.id}) < (${filter.after.lastMessageAt}::timestamptz, ${filter.after.id})`
        : undefined,
    ].filter((c) => c !== undefined);

    return this.txManager.conn
      .select({ ...getTableColumns(conversations), cursorLastMessageAt: CURSOR_LAST_MESSAGE_AT })
      .from(conversations)
      .where(and(...conditions))
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      .limit(filter.limit);
  }

  /**
   * 메시지 활동으로 대화를 최신으로 끌어올린다 (목록 정렬 키).
   * 소유 검증은 호출부(stream 진입 시 findById)가 이미 마쳤다.
   * now()로 쓰는 이유: 컬럼 기본값이 defaultNow()(DB 시계·마이크로초)라, 앱 시계의
   * 밀리초 값을 섞으면 방금 만든 대화가 touch 뒤에 오히려 뒤로 밀릴 수 있다.
   */
  async touchLastMessageAt(id: string): Promise<void> {
    await this.txManager.conn
      .update(conversations)
      .set({ lastMessageAt: sql`now()` })
      .where(eq(conversations.id, id));
  }

  /**
   * 자동 제목 1회 확정 — 아직 기본 제목인 대화에만 적중한다.
   * 「이미 제목이 있나」 판정을 별도 조회가 아니라 UPDATE의 WHERE에 실었으므로, 매 메시지마다
   * 호출되거나 동시 요청이 겹쳐도 첫 한 번만 성립한다(0행 갱신은 정상 경로다).
   * 소유 검증은 호출부(stream 진입 시 findById)가 이미 마쳤다 — touchLastMessageAt과 같다.
   */
  async applyAutoTitle(id: string, title: string): Promise<void> {
    await this.txManager.conn
      .update(conversations)
      .set({ title, titleSource: 'AUTO' })
      .where(and(eq(conversations.id, id), eq(conversations.titleSource, 'DEFAULT')));
  }

  /** 클리닉 스코프에서만 갱신 — 0행이면 미존재이거나 타 클리닉이다 (docs/specs/11·35) */
  async updateTitle(
    scope: ConversationScope,
    id: string,
    title: string,
  ): Promise<ConversationRow | null> {
    const rows = await this.txManager.conn
      .update(conversations)
      // 사용자가 직접 정한 제목이므로 이후 자동 제목이 덮지 못하도록 출처를 확정한다
      .set({ title, titleSource: 'USER' })
      .where(and(eq(conversations.id, id), eq(conversations.clinicId, scope.clinicId)))
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
      .where(and(eq(conversations.id, id), eq(conversations.clinicId, scope.clinicId)))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * 스코프 안에 존재하는가 — **파기 예약된 행도 존재로 센다.**
   *
   * 삭제 멱등(§34 기준 6)과 스코프 은닉(§34 기준 7)을 가르는 유일한 지점이다. `findById`는
   * 삭제된 행과 타 클리닉 행을 똑같이 null로 돌려주므로 그것만으로는 「이미 지운 우리 클리닉
   * 대화(200)」와 「타 클리닉 대화(404)」를 구분할 수 없다.
   */
  async existsInScope(scope: ConversationScope, id: string): Promise<boolean> {
    const rows = await this.txManager.conn
      .select({ one: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.clinicId, scope.clinicId)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * 파기 예약 (docs/specs/34) — **이미 값이 있으면 덮지 않는다.** 재삭제가 시각을 갱신하면
   * 재시도마다 파기가 미뤄진다 (기준 6).
   */
  async softDelete(scope: ConversationScope, id: string, deletedAt: Date): Promise<void> {
    await this.txManager.conn
      .update(conversations)
      .set({ deletedAt })
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.clinicId, scope.clinicId),
          isNull(conversations.deletedAt), // 이 조건이 「덮지 않는다」를 집행한다
        ),
      );
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
      .where(
        and(
          eq(messages.id, messageId),
          eq(conversations.clinicId, scope.clinicId),
          isNull(conversations.deletedAt), // docs/specs/34 — 삭제된 대화의 메시지는 피드백 경로에서도 없다
        ),
      )
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
