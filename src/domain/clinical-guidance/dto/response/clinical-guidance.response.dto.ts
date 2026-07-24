import { ApiProperty } from '@nestjs/swagger';
import { AnswerCitationResponseDto } from '../../../conversation/dto/response/answer-citation.response.dto';

export const REVIEW_STATUSES = ['DRAFT', 'ACCEPTED', 'MODIFIED', 'REJECTED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;

export class GuidanceConsiderationResponseDto {
  @ApiProperty()
  title!: string;

  @ApiProperty()
  rationale!: string;

  @ApiProperty({ type: [AnswerCitationResponseDto] })
  citations!: AnswerCitationResponseDto[];
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
