import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/**
 * 근거 전문의 언어 (docs/specs/44).
 *
 * **근거는 대화에 매이지 않은 코퍼스 리소스라 「저장된 언어」가 없다** — 지침 탐색기에서 열면
 * 대화가 아예 없다. 그래서 요청이 말해야 하고, 채팅 안에서는 그 메시지의 `responseLang`을,
 * 지침 탐색기에서는 UI 토글을 싣는다. 파라미터가 하나라 BE 계약은 두 경우에 같다.
 *
 * 미지정이면 `ko`다 — `lang` 없는 요청이 오늘과 같은 응답을 받는다(기준 1).
 */
export class EvidenceDetailQueryDto {
  @ApiProperty({ required: false, enum: ['ko', 'en'], default: 'ko' })
  @IsOptional()
  @IsIn(['ko', 'en'])
  lang?: 'ko' | 'en';
}
