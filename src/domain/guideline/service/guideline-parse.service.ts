import { Injectable, Logger } from '@nestjs/common';
import {
  ChunkDiagnostics,
  chunkNckmGuideline,
  GuidelineDocumentMeta,
} from '../../../infrastructure/document/guideline-chunker';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { SourceDocumentRepository } from '../repository/source-document.repository';
import { GuidelineIngestInput } from './guideline-ingest.input';
import {
  applyKnownSourceDefects,
  describeExpiry,
  findExpiredSourceDefects,
} from './known-source-defects';
import { GuidelineListProvider } from './guideline-list.provider';
import { RealTimeAlertSender } from '../../../global/observability/real-time-alert.sender';

const DEFAULT_SOURCE_SYSTEM = 'NCKM';

export interface ParseGuidelineOptions {
  /** PDF에서 추출한 페이지 텍스트 (추출은 CLI가 담당 — 서비스는 텍스트만 받는다) */
  pages: string[];
  /** NCKM guide_idx */
  externalId: string;
  /** 기본 'NCKM' */
  sourceSystem?: string;
  /** CLI 플래그로 넘어온 메타 오버라이드 */
  overrides?: Partial<GuidelineDocumentMeta>;
  /**
   * 본문 sha256 (docs/specs/25 기준 11). 면제 판정의 축이다 —
   * 파이프라인은 수집이 실어 온 값을, CLI는 읽은 파일의 해시를 넘긴다.
   */
  fileHash?: string;
}

/**
 * 지침 PDF 파싱 유스케이스 (docs/specs/19).
 *
 * PDF 텍스트에는 발행처·발행일이 없으므로 문서 메타는 §18이 적재한 `source_documents`에서 읽는다.
 * 조회·보정을 스크립트가 아니라 서비스에 두는 이유는 수용 기준 13을 e2e로 동결하기 위해서다.
 */
@Injectable()
export class GuidelineParseService {
  private readonly logger = new Logger(GuidelineParseService.name);

  constructor(
    private readonly sourceDocuments: SourceDocumentRepository,
    private readonly lists: GuidelineListProvider,
    private readonly alerts: RealTimeAlertSender,
  ) {}

  /**
   * 페이지 텍스트 + 조회한 메타 → 인제스트 입력.
   *
   * 진단에 문제가 있으면 **던진다** (docs/specs/20 수용 기준 1~4). 조용히 적게 내보내면
   * "인제스트했는데 아무것도 안 들어간" 문서가 생기고 아무도 모른다 — 특히 §21의 스케줄러가
   * 이 경로를 주기적으로 자동 실행하게 되므로, 불일치는 반드시 실패로 드러나야 한다.
   */
  async parse(options: ParseGuidelineOptions): Promise<GuidelineIngestInput> {
    const meta = await this.resolveMeta(options);
    const { input, diagnostics } = chunkNckmGuideline(options.pages, meta);

    // 파서가 고칠 수 없는 **원문 결함**은 명시 항목으로만 면제한다 (docs/specs/23 기준 9~13).
    // 가드를 넓히지 않고 예외를 좁히는 자리다 — 술어를 완화하면 앞으로 들어올 모든 문서에 적용된다.
    const sourceSystem = options.sourceSystem ?? DEFAULT_SOURCE_SYSTEM;
    const identity = {
      sourceSystem,
      externalId: options.externalId,
      version: meta.version,
      // §18이 그 다운로드에 기록한 해시 (docs/specs/25 기준 11)
      fileHash: options.fileHash ?? '',
    };
    const defects = this.lists.knownSourceDefects();
    const { diagnostics: effective, applied } = applyKnownSourceDefects(
      diagnostics,
      identity,
      defects,
    );
    for (const defect of applied) {
      // 조용히 통과시키지 않는다 — 무엇을 왜 면제했는지가 기록에 남아야 한다 (기준 12)
      this.logger.warn(
        `알려진 원문 결함 면제: ${sourceSystem} ${options.externalId}@${meta.version} ` +
          `${defect.diagnostic}=[${defect.numbers.join(', ')}] — ${defect.reason}`,
      );
    }

    // 면제가 만료됐으면 가드 실패의 원인을 짚어준다 (docs/specs/25 기준 6) —
    // 번호 열거만으로는 「면제 만료」와 「파서 회귀」를 구분할 수 없다.
    const expired = findExpiredSourceDefects(identity, defects);
    for (const candidate of expired) {
      this.logger.warn(
        `원문 결함 면제 만료: ${sourceSystem} ${options.externalId} ` +
          `${describeExpiry(candidate.mismatches)} — ${candidate.entry.reason}`,
      );
      try {
        this.alerts.send({
          title: `원문 결함 면제 만료: ${sourceSystem} ${options.externalId}`,
          detail: `${describeExpiry(candidate.mismatches)} — ${candidate.entry.reason}`,
        });
      } catch (error) {
        // 알림 실패가 파싱 결과를 바꾸지 않는다 (기준 9)
        this.logger.warn(`만료 알림 발송 실패: ${String(error)}`);
      }
    }

    assertParsable(effective, expired);
    return input;
  }

  /**
   * `source_documents`의 최신 행에서 문서 메타를 만든다.
   * `release_date`("2024-07")가 version이 되고, publishedAt은 일자를 1일로 보정한다.
   * 행이 없으면 예외를 던진다 — CLI 전용이라 에러코드 레지스트리를 타지 않고 종료코드로 알린다.
   */
  async resolveMeta(
    options: Pick<ParseGuidelineOptions, 'externalId' | 'sourceSystem' | 'overrides'>,
  ): Promise<GuidelineDocumentMeta> {
    const sourceSystem = options.sourceSystem ?? DEFAULT_SOURCE_SYSTEM;
    const row = await this.sourceDocuments.findLatestByExternalId(
      sourceSystem,
      options.externalId,
    );
    if (!row) {
      throw new Error(
        `${sourceSystem} ${options.externalId} 문서를 source_documents에서 찾지 못했습니다. ` +
          '먼저 `pnpm acquire:nckm --guide-idx <idx>`로 원본을 수집하세요.',
      );
    }

    const overrides = options.overrides ?? {};
    const releaseDate = row.releaseDate ?? undefined;
    const meta: GuidelineDocumentMeta = {
      title: overrides.title ?? row.title,
      publisher: overrides.publisher ?? row.publisher,
      sourceUrl: overrides.sourceUrl ?? row.sourceUrl,
      version: overrides.version ?? releaseDate ?? '',
      publishedAt: overrides.publishedAt ?? toIsoDate(releaseDate),
    };
    if (!meta.version || !meta.publishedAt) {
      throw new Error(
        `${sourceSystem} ${options.externalId}의 release_date가 없습니다. ` +
          '`--version`과 `--published-at`으로 직접 지정하세요.',
      );
    }
    return meta;
  }
}

/**
 * 파싱 실패 가드 (docs/specs/20 수용 기준 1~4).
 *
 * 어떤 번호가 문제인지 **data에 실어** 던진다 — 열거가 없으면 어디를 고쳐야 하는지 알 수 없다
 * (docs/specs/21). CLI도 같은 예외를 받지만 message가 사람이 읽을 요약을 담는다.
 */
function assertParsable(
  diagnostics: ChunkDiagnostics,
  expired: ReturnType<typeof findExpiredSourceDefects> = [],
): void {
  const { missing, duplicated, gradeMissing } = diagnostics;
  // 마커를 하나도 못 찾은 문서는 세 목록이 모두 비어 있어도 실패다 — 조용한 0청크 적재를 막는다
  const parsable =
    diagnostics.uniqueNumbers.length > 0 &&
    missing.length === 0 &&
    duplicated.length === 0 &&
    gradeMissing.length === 0;
  if (parsable) return;

  const problems: string[] = [];
  if (diagnostics.uniqueNumbers.length === 0) {
    problems.push('권고 블록 마커(【R…】)를 하나도 찾지 못했습니다');
  }
  if (missing.length > 0) {
    problems.push(`권고문 청크가 만들어지지 않은 번호: ${missing.join(', ')}`);
  }
  if (duplicated.length > 0) {
    problems.push(`권고문 청크가 중복 생성된 번호: ${duplicated.join(', ')}`);
  }
  if (gradeMissing.length > 0) {
    problems.push(`등급을 추출하지 못한 번호: ${gradeMissing.join(', ')}`);
  }

  // 만료된 면제가 있으면 그 사실을 함께 싣는다 (docs/specs/25 기준 6)
  for (const candidate of expired) {
    problems.push(
      `알려진 원문 결함 면제가 **만료**됐습니다 (${describeExpiry(candidate.mismatches)}) — ` +
        `원문이 바뀌었으니 결함이 고쳐졌는지 확인하고 known-source-defects.ts의 항목을 ` +
        `갱신하거나 지우세요. 기존 사유: ${candidate.entry.reason}`,
    );
  }

  // data는 세 목록으로 고정한다 (docs/specs/21 「추가 에러코드」) — FE 분기가 형태에 의존한다.
  // 사람이 읽을 열거는 detail로 간다 — CLI와 로그가 그것을 본다 (docs/specs/20 수용 기준 1·2·4).
  throw new ServiceException(
    'GUIDELINE_PARSE_FAILED',
    { missing, duplicated, gradeMissing },
    `지침 파싱 실패 — ${problems.join(' / ')}`,
  );
}

/** 목록이 "2024-07"처럼 일자 없이 주므로 1일로 보정한다 (§19 「문서 메타의 출처」) */
function toIsoDate(releaseDate: string | undefined): string {
  if (!releaseDate) return '';
  return /^\d{4}-\d{2}$/.test(releaseDate) ? `${releaseDate}-01` : releaseDate;
}
