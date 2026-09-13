import { IsIn, IsOptional, IsString, Length } from 'class-validator';

/**
 * 에이전트 턴 수락 (docs/specs/51). 채팅의 `SendMessageRequestDto`에서 `filters`만 뺀 모양이다 —
 * 에이전트 경로에는 검색 필터 UI가 없다. 제약은 채팅과 같다(같은 `messages` 행을 만든다).
 *
 * 내부 전용 API라 OpenAPI에 실리지 않으므로 Swagger 데코레이터를 달지 않는다.
 */
export class AcceptAgentTurnRequestDto {
  @IsString()
  @Length(1, 4000)
  content!: string;

  @IsString()
  @Length(1, 100)
  clientRequestId!: string;

  @IsOptional()
  @IsIn(['ko', 'en'])
  responseLang?: 'ko' | 'en';
}
