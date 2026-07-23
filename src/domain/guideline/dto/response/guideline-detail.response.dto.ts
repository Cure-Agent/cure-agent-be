import { ApiProperty } from '@nestjs/swagger';
import { GuidelineSummaryResponseDto } from './guideline-summary.response.dto';

export class GuidelineDetailResponseDto extends GuidelineSummaryResponseDto {
  @ApiProperty({ description: 'NCKM 원문 링크 — PDF는 재배포하지 않는다 (§5.4)' })
  sourceUrl!: string;
}
