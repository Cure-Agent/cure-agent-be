import { Injectable } from '@nestjs/common';
import { and, count, eq, inArray, isNotNull, lt, or } from 'drizzle-orm';
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
import { authSessions } from '../../auth/persistence/auth-session.schema';
import { clinicInvitations } from '../../clinician/persistence/clinic-invitation.schema';
import { clinicMemberRemovals } from '../../clinician/persistence/clinic-member-removal.schema';
import { clinics } from '../../clinician/persistence/clinic.schema';
import { clinicians } from '../../clinician/persistence/clinician.schema';
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

  /** 유예가 지난 클리닉 id (docs/specs/36) — 마지막 구성원이 떠나며 예약된 것들 */
  async findPurgeableClinicIds(cutoff: Date, limit: number): Promise<string[]> {
    const rows = await this.txManager.conn
      .select({ id: clinics.id })
      .from(clinics)
      .where(and(isNotNull(clinics.deletedAt), lt(clinics.deletedAt, cutoff)))
      .orderBy(clinics.deletedAt)
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /** 컷오프 이전에 삭제된 대화·환자·클리닉의 총 수 — 배치 상한으로 남긴 수 산출용 (기준 21) */
  async countPurgeable(
    cutoff: Date,
  ): Promise<{ conversations: number; patients: number; clinics: number }> {
    const [conversationRows, patientRows, clinicRows] = await Promise.all([
      this.txManager.conn
        .select({ total: count() })
        .from(conversations)
        .where(and(isNotNull(conversations.deletedAt), lt(conversations.deletedAt, cutoff))),
      this.txManager.conn
        .select({ total: count() })
        .from(patients)
        .where(and(isNotNull(patients.deletedAt), lt(patients.deletedAt, cutoff))),
      this.txManager.conn
        .select({ total: count() })
        .from(clinics)
        .where(and(isNotNull(clinics.deletedAt), lt(clinics.deletedAt, cutoff))),
    ]);
    return {
      conversations: conversationRows[0]?.total ?? 0,
      patients: patientRows[0]?.total ?? 0,
      clinics: clinicRows[0]?.total ?? 0,
    };
  }

  /**
   * 클리닉 전체 물리 삭제 (docs/specs/36) — 마지막 구성원이 떠난 클리닉이다.
   *
   * **`patients`·`conversations`·`clinical_guidances`에는 clinic FK가 없다**(실측). DB가
   * 막아주지 않으므로 이 세 계열을 clinic_id 기준으로 **직접 산출해 먼저 지운다** — 빠뜨리면
   * 조용히 고아가 된다. §34의 고아 스냅샷과 같은 자리이나 이번엔 제약이 없다는 사실 자체가 위험이다.
   *
   * ⑤단계(owner NULL)가 없으면 ⑥이 FK로 실패한다:
   * `clinics.owner_clinician_id → clinicians.id`와 `clinicians.clinic_id → clinics.id`가 순환이다.
   */
  async purgeClinics(clinicIds: string[]): Promise<void> {
    if (clinicIds.length === 0) return;
    const conn = this.txManager.conn;

    // ①② 대화·환자 계열 — clinic_id 기준으로 전건을 산출한다(deletedAt 유무와 무관하다)
    const conversationRows = await conn
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.clinicId, clinicIds));
    await this.purgeConversations(conversationRows.map((row) => row.id));

    const patientRows = await conn
      .select({ id: patients.id })
      .from(patients)
      .where(inArray(patients.clinicId, clinicIds));
    await this.purgePatients(patientRows.map((row) => row.id));

    // ③ 초대 (clinic FK 있음)
    await conn.delete(clinicInvitations).where(inArray(clinicInvitations.clinicId, clinicIds));

    const clinicianRows = await conn
      .select({ id: clinicians.id })
      .from(clinicians)
      .where(inArray(clinicians.clinicId, clinicIds));
    const clinicianIds = clinicianRows.map((row) => row.id);

    // ④ 세션
    if (clinicianIds.length > 0) {
      await conn.delete(authSessions).where(inArray(authSessions.clinicianId, clinicianIds));
    }

    /**
     * ④' 강퇴 이력 (docs/specs/38) — **두 축으로 지운다.**
     *
     * `clinic_id` 축만 지우면 안 된다: 강퇴당한 사람은 **다른 클리닉으로 옮겨 가므로**, 그
     * 사람의 새 클리닉이 파기될 때 옛 클리닉에 남은 이력 행이 그를 가리켜 ⑥ clinicians 삭제가
     * FK로 실패한다(FK는 전부 NO ACTION이다). 그래서 이 클리닉의 구성원을 가리키는 행도 함께
     * 지운다 — 살아 있는 다른 클리닉의 이력이 함께 사라지는 것은 **감수하는 손실**이다:
     * 행위자가 물리 삭제되면 「누가」가 비어 감사 기록으로서 의미가 없다.
     */
    const removalConditions = [
      inArray(clinicMemberRemovals.clinicId, clinicIds),
      clinicianIds.length > 0
        ? inArray(clinicMemberRemovals.removedClinicianId, clinicianIds)
        : undefined,
      clinicianIds.length > 0
        ? inArray(clinicMemberRemovals.removedByClinicianId, clinicianIds)
        : undefined,
    ].filter((condition) => condition !== undefined);
    await conn.delete(clinicMemberRemovals).where(or(...removalConditions));

    // ⑤ 순환 FK 절단. ⑥이 물리 삭제이던 시절의 필수 단계였고(docs/specs/36), 지금은 분리로
    // 바뀌어 반드시 필요하지는 않다 — 다만 clinic 행이 사라진 뒤 owner 참조를 남기지 않는다.
    await conn
      .update(clinics)
      .set({ ownerClinicianId: null })
      .where(inArray(clinics.id, clinicIds));

    /**
     * ⑥ 구성원 — **물리 삭제하지 않고 소속만 끊는다** (docs/specs/38).
     *
     * §38로 구성원이 클리닉 사이를 옮겨 다닐 수 있게 되면서, 파기 대상 클리닉의 구성원이
     * **다른 살아 있는 클리닉의 기록**에 참조될 수 있다 — 대화 작성자(`conversations`),
     * 피드백·검토(`answer_feedbacks`·`guidance_reviews`), 초대 발급자·수락자
     * (`clinic_invitations`), 잡 요청자(`guideline_jobs`). FK가 전부 NO ACTION이라 지우면 터진다.
     *
     * 그 참조를 끊으려면 **남의 클리닉 감사 기록을 지워야 하는데, 그것은 §36이 명시적으로
     * 보존하기로 한 것이다**(「탈퇴자가 만든 대화를 남은 동료가 여전히 조회한다」). 그래서 행을
     * 남긴다. 파기 예약된 클리닉의 구성원은 §36 경로상 이미 익명화된 tombstone이므로 남는 것은
     * **개인정보가 없는 빈 행**이고, 잃는 것은 없다.
     */
    if (clinicianIds.length > 0) {
      await conn
        .update(clinicians)
        .set({ clinicId: null })
        .where(inArray(clinicians.id, clinicianIds));
    }

    // ⑦ 클리닉
    await conn.delete(clinics).where(inArray(clinics.id, clinicIds));
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
