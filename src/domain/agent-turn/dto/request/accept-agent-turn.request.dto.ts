import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

/**
 * 에이전트 턴 수락 (docs/specs/51). 채팅의 `SendMessageRequestDto`에서 `filters`만 뺀 모양이다 —
 * 에이전트 경로에는 검색 필터 UI가 없다. 제약은 채팅과 같다(같은 `messages` 행을 만든다).
 *
 * 내부 수락 API 자체는 OpenAPI에 실리지 않지만, 브라우저가 부르는 에이전트 엔드포인트
 * (`POST /api/v1/agent/conversations/{id}/messages/stream`)의 요청 모델이 이 DTO와 같은 모양이라
 * docs/specs/52가 이 클래스를 **문서 전용 경로의 요청 스키마**로 공개 계약에 올린다 —
 * FE는 여기서 생성된 타입으로 본문을 조립한다. 에이전트 pydantic 모델과의 동기화는 여전히
 * 사람이 지킨다(spec 52 Out of scope).
 */
export class AcceptAgentTurnRequestDto {
  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @Length(1, 4000)
  content!: string;

  @ApiProperty({ description: '중복 생성 방지 키 — 재시도 시 같은 값 사용 (§8 복구 계약)' })
  @IsString()
  @Length(1, 100)
  clientRequestId!: string;

  /** 답변을 쓸 언어 (docs/specs/42) — FE가 입력 언어에서 유도해 싣는다. 미지정이면 `ko`. */
  @ApiProperty({ required: false, enum: ['ko', 'en'], default: 'ko' })
  @IsOptional()
  @IsIn(['ko', 'en'])
  responseLang?: 'ko' | 'en';
}
