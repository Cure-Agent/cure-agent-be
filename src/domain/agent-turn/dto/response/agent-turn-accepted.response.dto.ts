/** 수락이 만든 두 메시지 — 에이전트가 `message.accepted`로 흘리는 §8 복구 기준점이다 */
export class AgentTurnAcceptedResponseDto {
  userMessageId!: string;
  assistantMessageId!: string;
}
