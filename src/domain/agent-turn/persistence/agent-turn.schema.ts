import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';
import { messages } from '../../conversation/persistence/conversation.schema';
import { patientProfileSnapshots } from '../../patient/persistence/patient.schema';

/**
 * 에이전트가 실제로 실행한 경로 (docs/specs/51). 분류기 판정 원문이 아니라 실행 경로 표를 거친
 * 결과다 — 「GUIDELINE·라벨 1개」는 COMPOSITE로 남는다.
 */
export const agentRoute = pgEnum('agent_route', ['GUIDELINE', 'PATIENT', 'COMPOSITE', 'OTHER']);

/**
 * 에이전트가 수락한 턴 (docs/specs/51).
 *
 * **이 행이 있는 ASSISTANT 메시지만 내부 도구·완결이 다룬다** — 채팅이 만든 메시지와 가르는 유일한
 * 표지다. 대화 모델은 GUIDELINE_QA를 그대로 쓰므로(공개 계약 diff 0) 경로는 이 표에만 있다.
 */
export const agentTurns = pgTable(
  'agent_turns',
  {
    messageId: text('message_id')
      .primaryKey()
      .references(() => messages.id),
    userMessageId: text('user_message_id')
      .notNull()
      .references(() => messages.id),
    /** 경로가 정해지기 전(수락 직후)에는 NULL이다 */
    route: agentRoute('route'),
    classifierVersion: text('classifier_version'),
    /**
     * 환자 도구가 고정한 스냅샷. **환자 삭제 연쇄가 이 컬럼으로 대화를 찾는다** — 에이전트 턴은
     * `patient_id` 없는 대화에 얹혀 §34의 연쇄를 타지 못하기 때문이다.
     */
    patientSnapshotId: text('patient_snapshot_id').references(() => patientProfileSnapshots.id),
    ...baseColumns,
  },
  (table) => [
    // 삭제 연쇄 조회용 — 스냅샷을 쓴 턴은 소수라 NULL 행은 인덱스에 넣지 않는다
    index('idx_agent_turns_patient_snapshot')
      .on(table.patientSnapshotId)
      .where(sql`${table.patientSnapshotId} IS NOT NULL`),
  ],
);

export type AgentTurnRow = typeof agentTurns.$inferSelect;
export type AgentRoute = (typeof agentRoute.enumValues)[number];
