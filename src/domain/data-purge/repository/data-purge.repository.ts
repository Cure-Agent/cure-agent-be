import { Injectable } from '@nestjs/common';
import { and, count, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import {
  clinicalGuidances,
  guidanceReviews,
} from '../../clinical-guidance/persistence/clinical-guidance.schema';
import {
  answerFeedbacks,
  conversations,
  generationRuns,
  messageCitations,
  messages,
} from '../../conversation/persistence/conversation.schema';
import { patientProfileSnapshots, patients } from '../../patient/persistence/patient.schema';

/**
 * 파기 대상 산출과 FK 역순 물리 삭제 (docs/specs/34).
 *
 * **도메인을 가로지르는 유일한 리포지토리다.** 대화 계열(messages·citations·runs·feedbacks·
 * guidances·reviews)과 환자 계열(snapshots)을 **한 트랜잭션의 역순**으로 지워야 하므로
 * conversation·patient 리포지토리로 쪼개면 순서 보장이 호출자에게 흩어진다.
 */
@Injectable()
export class DataPurgeRepository {
  constructor(private readonly txManager: TransactionManager) {}

  /** 유예가 지난 대화 id — 컷오프는 앱 계층이 계산해 넘긴다 (기준 14) */
  async findPurgeableConversationIds(cutoff: Date, limit: number): Promise<string[]> {
    const rows = await this.txManager.conn
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(isNotNull(conversations.deletedAt), lt(conversations.deletedAt, cutoff)))
      .orderBy(conversations.deletedAt)
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /** 유예가 지난 환자 id — 컷오프는 앱 계층이 계산해 넘긴다 (기준 14) */
  async findPurgeablePatientIds(cutoff: Date, limit: number): Promise<string[]> {
    const rows = await this.txManager.conn
      .select({ id: patients.id })
      .from(patients)
      .where(and(isNotNull(patients.deletedAt), lt(patients.deletedAt, cutoff)))
      .orderBy(patients.deletedAt)
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /** 컷오프 이전에 삭제된 대화·환자의 총 수 — 배치 상한으로 남긴 수 산출용 (기준 21) */
  async countPurgeable(cutoff: Date): Promise<{ conversations: number; patients: number }> {
    const [conversationRows, patientRows] = await Promise.all([
      this.txManager.conn
        .select({ total: count() })
        .from(conversations)
        .where(and(isNotNull(conversations.deletedAt), lt(conversations.deletedAt, cutoff))),
      this.txManager.conn
        .select({ total: count() })
        .from(patients)
        .where(and(isNotNull(patients.deletedAt), lt(patients.deletedAt, cutoff))),
    ]);
    return {
      conversations: conversationRows[0]?.total ?? 0,
      patients: patientRows[0]?.total ?? 0,
    };
  }

  /**
   * 대화 계열 물리 삭제 (기준 15·16). FK가 전부 NO ACTION이라 **역순이 아니면 실패한다**:
   * guidance_reviews → clinical_guidances → message_citations → generation_runs →
   * answer_feedbacks → messages → conversations.
   */
  async purgeConversations(conversationIds: string[]): Promise<void> {
    if (conversationIds.length === 0) return;
    const conn = this.txManager.conn;

    const messageRows = await conn
      .select({ id: messages.id })
      .from(messages)
      .where(inArray(messages.conversationId, conversationIds));
    const messageIds = messageRows.map((row) => row.id);

    if (messageIds.length > 0) {
      const guidanceRows = await conn
        .select({ id: clinicalGuidances.id })
        .from(clinicalGuidances)
        .where(inArray(clinicalGuidances.messageId, messageIds));
      const guidanceIds = guidanceRows.map((row) => row.id);

      if (guidanceIds.length > 0) {
        await conn.delete(guidanceReviews).where(inArray(guidanceReviews.guidanceId, guidanceIds));
        await conn.delete(clinicalGuidances).where(inArray(clinicalGuidances.id, guidanceIds));
      }

      await conn.delete(messageCitations).where(inArray(messageCitations.messageId, messageIds));
      await conn.delete(generationRuns).where(inArray(generationRuns.messageId, messageIds));
      await conn.delete(answerFeedbacks).where(inArray(answerFeedbacks.messageId, messageIds));
      await conn.delete(messages).where(inArray(messages.id, messageIds));
    }

    await conn.delete(conversations).where(inArray(conversations.id, conversationIds));
  }

  /**
   * 환자 계열 물리 삭제 — patient_profile_snapshots → patients.
   *
   * **스냅샷은 `patient_id` 기준으로 지운다** (기준 17). 가이던스를 타고 내려가면 어떤 가이던스도
   * 참조하지 않는 고아 스냅샷(프로덕션 실측 1건 — 스냅샷이 생성 직전에 고정되므로 실패·취소된
   * 스트림이 남긴다)을 놓쳐 `patients` 삭제가 FK로 실패한다.
   */
  async purgePatients(patientIds: string[]): Promise<void> {
    if (patientIds.length === 0) return;
    const conn = this.txManager.conn;

    await conn
      .delete(patientProfileSnapshots)
      .where(inArray(patientProfileSnapshots.patientId, patientIds));
    await conn.delete(patients).where(inArray(patients.id, patientIds));
  }

  /** 이 환자를 참조하는 가이던스가 남아 있는가 — 환자 파기의 선행 조건 진단용 */
  async countGuidancesForPatient(patientId: string): Promise<number> {
    const rows = await this.txManager.conn
      .select({ total: count() })
      .from(clinicalGuidances)
      .where(eq(clinicalGuidances.patientId, patientId));
    return rows[0]?.total ?? 0;
  }
}
