import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  abstainReason,
  type MessageAbstainReason,
} from '../../../conversation/persistence/conversation.schema';
import { agentRoute, type AgentRoute } from '../../persistence/agent-turn.schema';

/** 완결이 닫을 수 있는 상태 — `STREAMING`으로 되돌리는 완결은 없다 */
export const AGENT_TURN_FINISH_STATUSES = ['COMPLETED', 'ABSTAINED', 'FAILED', 'CANCELLED'] as const;
export type AgentTurnFinishStatus = (typeof AGENT_TURN_FINISH_STATUSES)[number];

/** 답변 본문의 마커 n → 근거 id. quote는 BE가 채팅과 같은 규칙으로 만든다 */
export class AgentCitationRequestDto {
  @IsInt()
  @Min(1)
  marker!: number;

  @IsString()
  @Length(1, 100)
  evidenceId!: string;
}

/**
 * 에이전트 LLM 호출 1회의 재현성 기록 (§5.7·§9). `retrievalPolicyVersion`이 없으면
 * 「검색하지 않은 생성」(환자 경로)이다.
 */
export class AgentGenerationRequestDto {
  @IsString()
  @Length(1, 100)
  provider!: string;

  @IsString()
  @Length(1, 100)
  model!: string;

  @IsString()
  @Length(1, 100)
  promptVersion!: string;

  @IsInt()
  @Min(0)
  latencyMs!: number;

  @IsInt()
  @Min(0)
  inputTokens!: number;

  @IsInt()
  @Min(0)
  outputTokens!: number;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  retrievalPolicyVersion?: string;

  @IsOptional()
  @IsString()
  @Length(1, 10_000)
  searchQuestion?: string;
}

/** 완결 (docs/specs/51) — 환자·복합·기타 경로의 턴을 에이전트가 닫는다 */
export class FinishAgentTurnRequestDto {
  @IsIn(AGENT_TURN_FINISH_STATUSES)
  status!: AgentTurnFinishStatus;

  @IsOptional()
  @IsIn(agentRoute.enumValues)
  route?: AgentRoute;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  classifierVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  content?: string;

  @IsOptional()
  @IsIn(abstainReason.enumValues)
  abstainReason?: MessageAbstainReason;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgentCitationRequestDto)
  citations?: AgentCitationRequestDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => AgentGenerationRequestDto)
  generation?: AgentGenerationRequestDto;
}
