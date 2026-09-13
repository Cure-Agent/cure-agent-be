import { Module } from '@nestjs/common';
import { ConversationModule } from '../conversation/conversation.module';
import { PatientModule } from '../patient/patient.module';
import { AgentTurnInternalController } from './controller/agent-turn-internal.controller';
import { AgentTurnRepository } from './repository/agent-turn.repository';
import { AgentTurnService } from './service/agent-turn.service';

/**
 * 에이전트 턴 (docs/specs/51) — 에이전트 서비스가 딛는 내부 전용 API.
 *
 * 수락과 파이프라인은 대화 도메인의 것을 나눠 쓰고(채팅과 같은 저장 규칙), 이 모듈이 소유하는 것은
 * 턴 표·라벨 해석·완결 검증뿐이다.
 */
@Module({
  imports: [ConversationModule, PatientModule],
  controllers: [AgentTurnInternalController],
  providers: [AgentTurnService, AgentTurnRepository],
})
export class AgentTurnModule {}
