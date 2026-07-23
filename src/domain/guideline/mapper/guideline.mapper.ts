import {
  EvidenceChunkRow,
  GuidelineRow,
  GuidelineSectionRow,
  GuidelineVersionRow,
} from '../persistence/guideline.schema';
import { EvidenceDetailResponseDto } from '../dto/response/evidence-detail.response.dto';
import { EvidenceSummaryResponseDto } from '../dto/response/evidence-summary.response.dto';
import { GuidelineDetailResponseDto } from '../dto/response/guideline-detail.response.dto';
import { GuidelineSummaryResponseDto } from '../dto/response/guideline-summary.response.dto';

const EXCERPT_LIMIT = 200;

export function toGuidelineSummary(
  guideline: GuidelineRow,
  latestVersion: GuidelineVersionRow,
): GuidelineSummaryResponseDto {
  return {
    id: guideline.id,
    title: guideline.title,
    publisher: guideline.publisher,
    currentVersion: latestVersion.version,
    publishedAt: latestVersion.publishedAt.toISOString(),
    status: guideline.status,
  };
}

export function toGuidelineDetail(
  guideline: GuidelineRow,
  latestVersion: GuidelineVersionRow,
): GuidelineDetailResponseDto {
  return {
    ...toGuidelineSummary(guideline, latestVersion),
    sourceUrl: latestVersion.sourceUrl,
  };
}

export function toEvidenceSummary(
  chunk: EvidenceChunkRow,
  section: GuidelineSectionRow,
): EvidenceSummaryResponseDto {
  return {
    id: chunk.id,
    sectionPath: section.path,
    recommendationNumber: chunk.recommendationNumber ?? undefined,
    excerpt: truncate(chunk.content),
    recommendationGrade: chunk.recommendationGrade ?? undefined,
    evidenceLevel: chunk.evidenceLevel ?? undefined,
  };
}

export function toEvidenceDetail(row: {
  chunk: EvidenceChunkRow;
  section: GuidelineSectionRow;
  version: GuidelineVersionRow;
  guideline: GuidelineRow;
}): EvidenceDetailResponseDto {
  const { chunk, section, version, guideline } = row;
  return {
    id: chunk.id,
    guidelineId: guideline.id,
    guidelineVersionId: version.id,
    guidelineTitle: guideline.title,
    version: version.version,
    sectionPath: section.path,
    recommendationNumber: chunk.recommendationNumber ?? undefined,
    recommendationText: chunk.recommendationNumber ? chunk.content : undefined,
    recommendationGrade: chunk.recommendationGrade ?? undefined,
    evidenceLevel: chunk.evidenceLevel ?? undefined,
    excerpt: chunk.content,
    pageStart: chunk.pageStart ?? undefined,
    pageEnd: chunk.pageEnd ?? undefined,
    sourceUrl: version.sourceUrl,
  };
}

function truncate(content: string): string {
  return content.length <= EXCERPT_LIMIT ? content : `${content.slice(0, EXCERPT_LIMIT)}…`;
}
