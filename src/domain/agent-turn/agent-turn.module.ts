import { Module } from '@nestjs/common';
import { AgentTurnInternalController } from './controller/agent-turn-internal.controller';
import { AgentTurnService } from './service/agent-turn.service';

/** 에이전트 턴 (docs/specs/51) — 에이전트 서비스가 딛는 내부 전용 API */
@Module({
  controllers: [AgentTurnInternalController],
  providers: [AgentTurnService],
})
export class AgentTurnModule {}
