import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { TransactionManager } from '../../../global/database/transaction-manager';
import {
  ConversationRow,
  MessageRow,
  conversations,
  messages,
} from '../../conversation/persistence/conversation.schema';
import { PatientRow, patients } from '../../patient/persistence/patient.schema';
import { AgentRoute, AgentTurnRow, agentTurns } from '../persistence/agent-turn.schema';

/** §4.4 — 턴은 그 대화의 클리닉 스코프로만 닿는다 (대화는 클리닉 공유 자산, docs/specs/35) */
export interface AgentTurnScope {
  clinicId: string;
}

export interface LoadedAgentTurn {
  turn: AgentTurnRow;
  assistant: MessageRow;
  user: MessageRow;
  conversation: ConversationRow;
}

/** 모호함 판정에는 두 행이면 충분하다 — 세 번째부터는 결론을 바꾸지 않는다 */
const AMBIGUITY_PROBE = 2;

@Injectable()
export class AgentTurnRepository {
  constructor(private readonly txManager: TransactionManager) {}

  async insert(row: Pick<AgentTurnRow, 'messageId' | 'userMessageId'>): Promise<void> {
    await this.txManager.conn.insert(agentTurns).values(row);
  }

  /**
   * 수락이 만든 턴 — **이 행이 없으면 내부 도구·완결이 다룰 메시지가 아니다**(404, 기준 86).
   * 파기 예약된 대화의 턴도 없는 것으로 본다 — 대화 조회의 단일 관문과 같은 규칙이다(§34).
   */
  async findInScope(
    scope: AgentTurnScope,
    assistantMessageId: string,
  ): Promise<LoadedAgentTurn | null> {
    const userMessages = alias(messages, 'user_messages');
    const rows = await this.txManager.conn
      .select({
        turn: agentTurns,
        assistant: messages,
        user: userMessages,
        conversation: conversations,
      })
      .from(agentTurns)
      .innerJoin(messages, eq(messages.id, agentTurns.messageId))
      .innerJoin(userMessages, eq(userMessages.id, agentTurns.userMessageId))
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(agentTurns.messageId, assistantMessageId),
          eq(conversations.clinicId, scope.clinicId),
          isNull(conversations.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** 경로·분류기 버전 기록 — 넘긴 항목만 바꾼다 */
  async recordRoute(
    messageId: string,
    patch: { route?: AgentRoute; classifierVersion?: string },
  ): Promise<void> {
    const set = {
      ...(patch.route !== undefined ? { route: patch.route } : {}),
      ...(patch.classifierVersion !== undefined
        ? { classifierVersion: patch.classifierVersion }
        : {}),
    };
    if (Object.keys(set).length === 0) return;
    await this.txManager.conn
      .update(agentTurns)
      .set(set)
      .where(eq(agentTurns.messageId, messageId));
  }

  /**
   * 턴 행을 **배타 잠금**하고 고정된 스냅샷 id를 읽는다 — tx 안에서만 뜻이 있다.
   * 같은 턴의 환자 도구가 동시에 와도 한 번만 고정되게 직렬화한다(재시도 멱등, 기준 95).
   */
  async lockPatientSnapshotId(messageId: string): Promise<string | null> {
    const rows = await this.txManager.conn
      .select({ patientSnapshotId: agentTurns.patientSnapshotId })
      .from(agentTurns)
      .where(eq(agentTurns.messageId, messageId))
      .for('update');
    return rows[0]?.patientSnapshotId ?? null;
  }

  async pinPatientSnapshot(messageId: string, snapshotId: string): Promise<void> {
    await this.txManager.conn
      .update(agentTurns)
      .set({ patientSnapshotId: snapshotId })
      .where(eq(agentTurns.messageId, messageId));
  }

  /**
   * 케이스 라벨 해석 (docs/specs/51) — **대소문자 무시 정확 일치 · 클리닉 스코프 · 삭제 제외.**
   *
   * 목록 검색(`PatientRepository.list`)의 부분일치 `ILIKE`를 쓰지 않는다 — `CASE-00`이 `CASE-001`을
   * 가리키면 질문이 지목하지 않은 환자의 기록을 옮기게 된다(기준 91). `caseLabel`은 unique가 아니라
   * 둘 이상이 맞으면 호출자가 모호함으로 끝낸다(기준 93). 보관(ARCHIVED)은 제외하지 않는다 — 보관은
   * 목록 정리이지 기록의 소멸이 아니다.
   *
   * **맞은 행을 공유 잠금한다** — tx 안에서 부르면 스냅샷을 턴에 고정할 때까지 그 환자의 삭제가
   * 기다린다. 기다리지 않으면 삭제의 연쇄가 방금 고정된 턴을 못 본 채 끝나고, 스냅샷을 가리키는 턴이
   * 살아 있는 대화에 남아 유예 뒤 환자 파기가 FK로 실패한다(`PatientService.remove` 순서 주석 참조).
   */
  async findPatientsByCaseLabel(scope: AgentTurnScope, caseLabel: string): Promise<PatientRow[]> {
    return this.txManager.conn
      .select()
      .from(patients)
      .where(
        and(
          eq(patients.clinicId, scope.clinicId),
          isNull(patients.deletedAt),
          sql`lower(${patients.caseLabel}) = lower(${caseLabel})`,
        ),
      )
      .limit(AMBIGUITY_PROBE)
      .for('share');
  }
}
