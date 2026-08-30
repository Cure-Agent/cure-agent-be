import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { SupportedLang } from '../../../infrastructure/llm/translation/translator.port';
import { conversations, messages } from '../../conversation/persistence/conversation.schema';
import {
  ClinicalGuidanceRow,
  clinicalGuidances,
  guidanceReviews,
} from '../persistence/clinical-guidance.schema';

/** §4.4 — 가이던스는 환자 계열 리소스: clinicId 스코프 */
export interface GuidanceScope {
  clinicId: string;
}

/**
 * 참고안 행 + 그것이 매인 메시지의 응답 언어 (docs/specs/44).
 *
 * `GET /clinical-guidance/{id}`에는 언어가 실리지 않는다 — 참고안은 한 대화의 산물이라
 * **저장된 언어가 있고**, 그것이 `messages.response_lang`이다. 새 컬럼을 두지 않고 조인으로
 * 읽는 이유는 한 사실을 두 곳에 적으면 갈리기 때문이다.
 */
export type GuidanceWithLangRow = ClinicalGuidanceRow & { responseLang: SupportedLang };

/** 컬럼은 text라 어떤 문자열도 담을 수 있다 — 아는 언어가 아니면 기본값으로 닫는다 (§42 기준 3) */
function langOf(value: string | null | undefined): SupportedLang {
  return value === 'en' ? 'en' : 'ko';
}

@Injectable()
export class ClinicalGuidanceRepository {
  constructor(private readonly txManager: TransactionManager) {}

  async insert(row: typeof clinicalGuidances.$inferInsert): Promise<ClinicalGuidanceRow> {
    const rows = await this.txManager.conn.insert(clinicalGuidances).values(row).returning();
    return rows[0];
  }

  /**
   * 가이던스에는 `deletedAt`이 없다 — 뿌리(대화)를 통해서만 가려진다 (docs/specs/34).
   * 환자 삭제는 그 환자의 대화까지 연쇄 예약하므로, 이 조인 하나가 두 경로를 모두 덮는다.
   * 검토 기록(`POST .../reviews`)도 같은 메서드를 지나므로 함께 닫힌다.
   */
  async findById(scope: GuidanceScope, id: string): Promise<GuidanceWithLangRow | null> {
    const rows = await this.txManager.conn
      .select({ guidance: clinicalGuidances, responseLang: messages.responseLang })
      .from(clinicalGuidances)
      // 참고안은 message_id FK로 메시지에 1:1로 매인다 — 삭제 가리개(exists)가 보던 그
      // 메시지를 이제 조인으로 세워 렌더 언어까지 함께 읽는다 (docs/specs/44)
      .innerJoin(messages, eq(messages.id, clinicalGuidances.messageId))
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(clinicalGuidances.id, id),
          eq(clinicalGuidances.clinicId, scope.clinicId),
          isNull(conversations.deletedAt), // docs/specs/34 — 삭제된 대화의 참고안은 없다
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? { ...row.guidance, responseLang: langOf(row.responseLang) } : null;
  }

  /** 참고안이 매인 메시지의 응답 언어 — UPDATE ... RETURNING에는 조인을 붙일 수 없어 따로 읽는다 */
  private async findResponseLang(guidanceId: string): Promise<SupportedLang> {
    const rows = await this.txManager.conn
      .select({ responseLang: messages.responseLang })
      .from(clinicalGuidances)
      .innerJoin(messages, eq(messages.id, clinicalGuidances.messageId))
      .where(eq(clinicalGuidances.id, guidanceId))
      .limit(1);
    return langOf(rows[0]?.responseLang);
  }

  /** 메시지 목록에 guidanceId를 실어주기 위한 일괄 조회 — messageId → guidanceId */
  async findIdsByMessageIds(scope: GuidanceScope, messageIds: string[]): Promise<Map<string, string>> {
    if (messageIds.length === 0) return new Map();
    const rows = await this.txManager.conn
      .select({ id: clinicalGuidances.id, messageId: clinicalGuidances.messageId })
      .from(clinicalGuidances)
      .where(
        and(
          inArray(clinicalGuidances.messageId, messageIds),
          eq(clinicalGuidances.clinicId, scope.clinicId),
        ),
      );
    return new Map(rows.map((row) => [row.messageId, row.id]));
  }

  /** DRAFT일 때만 상태 전이 — 경합 시 0행 갱신으로 재검토를 원자적으로 차단한다 */
  async updateStatusIfDraft(
    scope: GuidanceScope,
    id: string,
    status: ClinicalGuidanceRow['reviewStatus'],
  ): Promise<GuidanceWithLangRow | null> {
    const rows = await this.txManager.conn
      .update(clinicalGuidances)
      .set({ reviewStatus: status })
      .where(
        and(
          eq(clinicalGuidances.id, id),
          eq(clinicalGuidances.clinicId, scope.clinicId),
          eq(clinicalGuidances.reviewStatus, 'DRAFT'),
        ),
      )
      .returning();
    if (!rows[0]) return null;
    return { ...rows[0], responseLang: await this.findResponseLang(rows[0].id) };
  }

  async insertReview(row: typeof guidanceReviews.$inferInsert): Promise<void> {
    await this.txManager.conn.insert(guidanceReviews).values(row);
  }
}
