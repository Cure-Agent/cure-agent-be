import { ApiProperty } from '@nestjs/swagger';
import { RatingResponseDto } from './rating.response.dto';

/** §7 EvidenceDetailResponseDto 계약 그대로. */
export class EvidenceDetailResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  guidelineId!: string;

  @ApiProperty()
  guidelineVersionId!: string;

  @ApiProperty()
  guidelineTitle!: string;

  @ApiProperty({ example: '1.0' })
  version!: string;

  @ApiProperty({ type: [String] })
  sectionPath!: string[];

  @ApiProperty({ required: false })
  recommendationNumber?: string;

  @ApiProperty({ required: false, description: '권고문 원문 (권고 청크인 경우)' })
  recommendationText?: string;

  @ApiProperty({ type: RatingResponseDto, required: false })
  recommendationGrade?: RatingResponseDto;

  @ApiProperty({ type: RatingResponseDto, required: false })
  evidenceLevel?: RatingResponseDto;

  @ApiProperty({ description: '본문 발췌 전문' })
  excerpt!: string;

  @ApiProperty({ required: false })
  pageStart?: number;

  @ApiProperty({ required: false })
  pageEnd?: number;

  @ApiProperty()
  sourceUrl!: string;

  /**
   * `excerpt`의 번역 (docs/specs/42). 답변 언어가 근거 원문 언어와 다를 때만 실린다.
   * 번역이 없거나 원문 개정으로 낡았으면 **키 자체가 빠진다** — 빈 문자열을 싣지 않는다(기준 14·15).
   */
  @ApiProperty({ required: false, description: '본문 발췌 전문의 번역 (기계 번역)' })
  excerptTranslated?: string;

  @ApiProperty({ required: false, description: '지침 제목의 번역 (기계 번역)' })
  titleTranslated?: string;

  /**
   * `recommendationText`의 번역 (docs/specs/44). 권고 청크에서 두 원문이 같으므로 원천도
   * `excerptTranslated`와 같다 — 권고 청크가 아니면 원문과 함께 키가 빠진다.
   */
  @ApiProperty({ required: false, description: '권고문 원문의 번역 (기계 번역)' })
  recommendationTextTranslated?: string;

  /**
   * `sectionPath`의 번역 (docs/specs/44) — 원문과 **같은 길이의 배열**이다.
   * 펼침 헤더 한 줄 안에서 언어가 갈리지 않게 한다. 없으면 키가 빠지고 화면이 원문으로 폴백한다.
   */
  @ApiProperty({ required: false, type: [String], description: '섹션 경로의 번역 (기계 번역)' })
  sectionPathTranslated?: string[];

  @ApiProperty({ required: false, description: '번역을 만든 모델 — provenance' })
  translationModel?: string;
}
