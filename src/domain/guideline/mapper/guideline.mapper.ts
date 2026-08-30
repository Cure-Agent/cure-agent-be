import {
  EvidenceChunkRow,
  EvidenceChunkTranslationRow,
  GuidelineRow,
  GuidelineSectionRow,
  GuidelineVersionRow,
} from '../persistence/guideline.schema';
import { SupportedLang } from '../../../infrastructure/llm/translation/translator.port';
import { usableTranslation } from './translation.util';
import { AdminGuidelineVersionResponseDto } from '../dto/response/admin-guideline-version.response.dto';
import { AdminGuidelineResponseDto } from '../dto/response/admin-guideline.response.dto';
import { EvidenceDetailResponseDto } from '../dto/response/evidence-detail.response.dto';
import { EvidenceSummaryResponseDto } from '../dto/response/evidence-summary.response.dto';
import { GuidelineDetailResponseDto } from '../dto/response/guideline-detail.response.dto';
import { GuidelineSummaryResponseDto } from '../dto/response/guideline-summary.response.dto';

const EXCERPT_LIMIT = 200;

export function toGuidelineSummary(
  guideline: GuidelineRow,
  latestVersion: GuidelineVersionRow,
  /** 청크 번역에서 온 제목 번역 (docs/specs/44) — 없으면 키 부재로 닫혀 원문이 표시된다 */
  titleTranslated?: string,
): GuidelineSummaryResponseDto {
  void titleTranslated; // 스텁 — 탑재는 구현 단계에서
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

export function toEvidenceDetail(
  row: {
    chunk: EvidenceChunkRow;
    section: GuidelineSectionRow;
    version: GuidelineVersionRow;
    guideline: GuidelineRow;
    /** 적재된 번역 (docs/specs/42) — 없거나 낡았으면 번역 키가 응답에서 빠진다 */
    translation?: EvidenceChunkTranslationRow | null;
  },
  /**
   * **선택이 아니라 필수다** (docs/specs/44) — 안 넘기면 조용히 한국어가 되는 것이 이 결함의
   * 구조적 원인이었다(`GET /evidence/{id}`가 기본 `'ko'`로 즉시 닫혀 영원히 한국어였다).
   */
  responseLang: SupportedLang,
): EvidenceDetailResponseDto {
  const { chunk, section, version, guideline } = row;
  const translation = usableTranslation(row.translation, chunk.contentHash, responseLang);
  return {
    ...(translation
      ? {
          excerptTranslated: translation.content,
          translationModel: translation.translatorModel,
          ...(translation.titleTranslated
            ? { titleTranslated: translation.titleTranslated }
            : {}),
        }
      : {}),
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

// ── 코퍼스 관리 (docs/specs/21) ────────────────────────

export function toAdminGuidelineVersion(
  version: GuidelineVersionRow & { chunkCount: number },
): AdminGuidelineVersionResponseDto {
  return {
    id: version.id,
    version: version.version,
    revision: version.revision,
    status: version.status,
    publishedAt: version.publishedAt.toISOString(),
    contentHash: version.contentHash,
    chunkCount: version.chunkCount,
  };
}

export function toAdminGuideline(
  guideline: GuidelineRow,
  versions: (GuidelineVersionRow & { chunkCount: number })[],
): AdminGuidelineResponseDto {
  return {
    id: guideline.id,
    title: guideline.title,
    publisher: guideline.publisher,
    versions: versions.map(toAdminGuidelineVersion),
  };
}

function truncate(content: string): string {
  return content.length <= EXCERPT_LIMIT ? content : `${content.slice(0, EXCERPT_LIMIT)}…`;
}
