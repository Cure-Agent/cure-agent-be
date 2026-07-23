import { Module } from '@nestjs/common';
import { LlmModule } from '../../infrastructure/llm/llm.module';
import { RetrievalModule } from '../../infrastructure/retrieval/retrieval.module';
import { ConversationController } from './controller/conversation.controller';
import { FeedbackController } from './controller/feedback.controller';
import { ConversationRepository } from './repository/conversation.repository';
import { ConversationStreamService } from './service/conversation-stream.service';
import { ConversationService } from './service/conversation.service';

@Module({
  imports: [RetrievalModule, LlmModule],
  controllers: [ConversationController, FeedbackController],
  providers: [ConversationService, ConversationStreamService, ConversationRepository],
})
export class ConversationModule {}
