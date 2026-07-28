import { ApiProperty } from '@nestjs/swagger';
import { GuidelineVersionStatus } from './admin-guideline-version.response.dto';

/**
 * 원본 수집 판정 (docs/specs/18). `FAILED`는 여기 오지 않는다 —
 * 원본을 못 가져온 것은 502 `GUIDELINE_SOURCE_UNAVAILABLE`이다.
 */
export const ADMIN_INGEST_SOURCE_STATUSES = ['FETCHED', 'SKIPPED_NO_ATTACHMENT'] as const;
export type AdminIngestSourceStatus = (typeof ADMIN_INGEST_SOURCE_STATUSES)[number];

export class AdminIngestStatsDto {
  @ApiProperty()
  sections!: number;

  @ApiProperty()
  chunks!: number;

  @ApiProperty({ description: '버전 내 중복 콘텐츠로 건너뛴 청크 수' })
  skippedChunks!: number;
}

/**
 * 1건 파이프라인 결과 (docs/specs/21).
 * 동기 실행이라 무슨 일이 있었는지가 이 응답에 그대로 담긴다 — `ingestion_runs` 조회 API가
 * 아직 없는 이유이기도 하다.
 */
export class AdminIngestResponseDto {
  @ApiProperty({ example: '325', description: 'NCKM guide_idx' })
  externalId!: string;

  @ApiProperty({
    enum: ADMIN_INGEST_SOURCE_STATUSES,
    description: '첨부가 없는 문서는 에러가 아니라 SKIPPED_NO_ATTACHMENT로 200 응답이다',
  })
  sourceStatus!: AdminIngestSourceStatus;

  @ApiProperty({ description: '새 revision을 만들었는가 — 동일 contentHash 재적재면 false' })
  created!: boolean;

  @ApiProperty({ type: String, nullable: true })
  guidelineId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  guidelineVersionId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2024-07' })
  version!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 1 })
  revision!: number | null;

  @ApiProperty({ enum: ['ACTIVE', 'SUPERSEDED'], nullable: true })
  status!: GuidelineVersionStatus | null;

  @ApiProperty({ type: AdminIngestStatsDto, nullable: true })
  stats!: AdminIngestStatsDto | null;
}
