import { Module } from '@nestjs/common';
import { LlmModule } from '../../infrastructure/llm/llm.module';
import { RetrievalModule } from '../../infrastructure/retrieval/retrieval.module';
import { ClinicalGuidanceModule } from '../clinical-guidance/clinical-guidance.module';
import { PatientModule } from '../patient/patient.module';
import { ConversationController } from './controller/conversation.controller';
import { FeedbackController } from './controller/feedback.controller';
import { ConversationRepository } from './repository/conversation.repository';
import { ConversationStreamService } from './service/conversation-stream.service';
import { ConversationService } from './service/conversation.service';

@Module({
  imports: [RetrievalModule, LlmModule, PatientModule, ClinicalGuidanceModule],
  controllers: [ConversationController, FeedbackController],
  providers: [ConversationService, ConversationStreamService, ConversationRepository],
  // 에이전트 턴(docs/specs/51)이 수락과 파이프라인을 채팅과 나눠 쓴다
  exports: [ConversationStreamService, ConversationRepository],
})
export class ConversationModule {}
