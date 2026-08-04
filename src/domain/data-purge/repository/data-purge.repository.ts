import { Injectable } from '@nestjs/common';
import { TransactionManager } from '../../../global/database/transaction-manager';

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
  async findPurgeableConversationIds(_cutoff: Date, _limit: number): Promise<string[]> {
    return Promise.resolve([]);
  }

  /** 유예가 지난 환자 id — 컷오프는 앱 계층이 계산해 넘긴다 (기준 14) */
  async findPurgeablePatientIds(_cutoff: Date, _limit: number): Promise<string[]> {
    return Promise.resolve([]);
  }

  /** 컷오프 이전에 삭제된 대화·환자의 총 수 — 배치 상한으로 남긴 수 산출용 (기준 21) */
  async countPurgeable(_cutoff: Date): Promise<{ conversations: number; patients: number }> {
    return Promise.resolve({ conversations: 0, patients: 0 });
  }

  /**
   * 대화 계열 물리 삭제 — guidance_reviews → clinical_guidances → message_citations →
   * generation_runs → answer_feedbacks → messages → conversations 역순 (기준 15·16)
   */
  async purgeConversations(_conversationIds: string[]): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 환자 계열 물리 삭제 — patient_profile_snapshots → patients.
   *
   * **스냅샷은 `patient_id` 기준으로 지운다** — 가이던스를 타고 내려가면 어떤 가이던스도
   * 참조하지 않는 고아 스냅샷(프로덕션 실측 1건)을 놓쳐 `patients` 삭제가 FK로 실패한다 (기준 17).
   */
  async purgePatients(_patientIds: string[]): Promise<void> {
    return Promise.resolve();
  }
}
