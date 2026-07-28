import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import {
  GUIDELINE_VERSION_STATUSES,
  GuidelineVersionStatus,
} from '../response/admin-guideline-version.response.dto';

/**
 * 버전 폐기·복구 (docs/specs/21).
 * 요청한 버전의 status만 바꾼다 — 승격이 같은 판본의 다른 revision을 자동으로 내리지 않는다.
 */
export class UpdateVersionStatusRequestDto {
  @ApiProperty({ enum: GUIDELINE_VERSION_STATUSES })
  @IsIn(GUIDELINE_VERSION_STATUSES)
  status!: GuidelineVersionStatus;
}
