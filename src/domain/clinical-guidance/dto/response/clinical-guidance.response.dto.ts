import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AnswerCitationResponseDto } from '../../../conversation/dto/response/answer-citation.response.dto';

export const REVIEW_STATUSES = ['DRAFT', 'ACCEPTED', 'MODIFIED', 'REJECTED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;

/**
 * 적용 판단 3값 (docs/specs/33). 근거의 조건·금기가 프로필의 어느 값과 만나는지만 가르는 축이며,
 * 근거 사이의 우선순위·비교 우위는 여기에 없다 — 그건 qa-v5가 막는 창작이다 (docs/specs/32).
 * 검증기가 이 목록만 통과시키므로, 여기가 어휘의 **집행 지점**이다.
 */
export const GUIDANCE_APPLICABILITIES = ['APPLICABLE', 'CAUTION', 'NOT_APPLICABLE'] as const;
export type GuidanceApplicability = (typeof GUIDANCE_APPLICABILITIES)[number];

export class GuidanceConsiderationResponseDto {
  @ApiProperty()
  title!: string;

  @ApiProperty()
  rationale!: string;

  @ApiProperty({ type: [AnswerCitationResponseDto] })
  citations!: AnswerCitationResponseDto[];

  @ApiPropertyOptional({
    enum: GUIDANCE_APPLICABILITIES,
    description: '근거 조건과 환자 프로필이 만나는 지점의 적용 판단 — 구조화 경로에서만 실린다',
  })
  applicability?: GuidanceApplicability;

  @ApiPropertyOptional({
    type: [String],
    description: '이 판단이 딛고 선 환자 프로필 필드명 — missingInformation과 같은 어휘의 여집합',
  })
  patientFactors?: string[];
}

export class SafetyAlertResponseDto {
  @ApiProperty({ enum: ALERT_SEVERITIES })
  severity!: (typeof ALERT_SEVERITIES)[number];

  @ApiProperty()
  description!: string;

  @ApiProperty({ type: [AnswerCitationResponseDto] })
  citations!: AnswerCitationResponseDto[];
}

/** §7 ClinicalGuidanceResponseDto — 확정 처방이 아닌 검토 대상 참고안 (§5.6) */
export class ClinicalGuidanceResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  patientId!: string;

  @ApiProperty()
  patientProfileSnapshotId!: string;

  @ApiProperty()
  summary!: string;

  @ApiProperty({ type: [GuidanceConsiderationResponseDto] })
  considerations!: GuidanceConsiderationResponseDto[];

  @ApiProperty({ type: [SafetyAlertResponseDto] })
  safetyAlerts!: SafetyAlertResponseDto[];

  @ApiProperty({ type: [String] })
  missingInformation!: string[];

  @ApiProperty({ enum: REVIEW_STATUSES })
  reviewStatus!: ReviewStatus;

  @ApiProperty({ description: 'ISO 8601' })
  generatedAt!: string;
}
