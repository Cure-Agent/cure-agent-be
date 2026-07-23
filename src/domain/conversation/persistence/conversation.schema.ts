import { index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../../global/database/base-columns';
import { clinicians } from '../../clinician/persistence/clinician.schema';
import { evidenceChunks } from '../../guideline/persistence/guideline.schema';

export const conversationType = pgEnum('conversation_type', ['GUIDELINE_QA', 'PATIENT_GUIDANCE']);
export const conversationStatus = pgEnum('conversation_status', ['ACTIVE', 'ARCHIVED']);
export const messageRole = pgEnum('message_role', ['USER', 'ASSISTANT']);
export const messageStatus = pgEnum('message_status', [
  'STREAMING',
  'COMPLETED',
  'ABSTAINED',
  'FAILED',
  'CANCELLED',
]);
export const answerKind = pgEnum('answer_kind', ['GUIDELINE_ANSWER', 'CLINICAL_GUIDANCE']);
export const feedbackRating = pgEnum('feedback_rating', ['HELPFUL', 'NOT_HELPFUL']);

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(), // ULID
    clinicianId: text('clinician_id')
      .notNull()
      .references(() => clinicians.id),
    clinicId: text('clinic_id').notNull(),
    type: conversationType('type').notNull(),
    patientId: text('patient_id'), // 9단계(PATIENT_GUIDANCE)에서 사용
    title: text('title').notNull(),
    status: conversationStatus('status').notNull().default('ACTIVE'),
    ...baseColumns,
  },
  (table) => [index('idx_conversations_clinician').on(table.clinicianId)],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    role: messageRole('role').notNull(),
    content: text('content').notNull(),
    status: messageStatus('status').notNull(),
    answerKind: answerKind('answer_kind'),
    // 네트워크 재시도 중복 생성 방지 (§6 SendMessageRequestDto) — unique는 NULL 다중 허용
    clientRequestId: text('client_request_id'),
    ...baseColumns,
  },
  (table) => [
    uniqueIndex('uq_messages_client_request').on(table.clientRequestId),
    index('idx_messages_conversation').on(table.conversationId),
  ],
);

export const messageCitations = pgTable(
  'message_citations',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id),
    evidenceChunkId: text('evidence_chunk_id')
      .notNull()
      .references(() => evidenceChunks.id),
    marker: integer('marker').notNull(),
    quote: text('quote').notNull(),
    ...baseColumns,
  },
  (table) => [index('idx_message_citations_message').on(table.messageId)],
);

export const generationRuns = pgTable('generation_runs', {
  id: text('id').primaryKey(),
  messageId: text('message_id')
    .notNull()
    .references(() => messages.id),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  promptVersion: text('prompt_version').notNull(),
  retrievalPolicyVersion: text('retrieval_policy_version').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  tokenUsage: jsonb('token_usage').$type<{ inputTokens: number; outputTokens: number }>(),
  traceId: text('trace_id').notNull(),
  ...baseColumns,
});

export const answerFeedbacks = pgTable(
  'answer_feedbacks',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id),
    clinicianId: text('clinician_id')
      .notNull()
      .references(() => clinicians.id),
    rating: feedbackRating('rating').notNull(),
    reasonCodes: text('reason_codes').array(),
    comment: text('comment'),
    ...baseColumns,
  },
  (table) => [uniqueIndex('uq_answer_feedbacks_message_clinician').on(table.messageId, table.clinicianId)],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MessageCitationRow = typeof messageCitations.$inferSelect;
