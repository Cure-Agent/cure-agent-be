/**
 * 안정 키 → 실제 청크 해석 (docs/specs/27 수용 기준 4).
 *
 * 해석이 0건이면 그 문항을 **건너뛰지 않고 에러로 끝낸다** — 조용한 스킵은 라벨 부패를 숨기고,
 * 남은 문항만으로 계산된 기준선이 실제보다 좋아 보이게 만든다.
 */
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  evidenceChunks,
  guidelineSections,
  guidelineVersions,
  guidelines,
} from '../guideline/persistence/guideline.schema';
import { TransactionManager } from '../../global/database/transaction-manager';
import { ExpectedEvidence } from './evalset.types';

/** 승인 문항의 안정 키가 코퍼스에 0건 매칭일 때 */
export class LabelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabelResolutionError';
  }
}

/** 한 문항의 기대 근거가 가리키는 청크 ID 집합 */
export interface ResolvedLabel {
  itemId: string;
  chunkIds: string[];
}

/** 에러 메시지용 — 어떤 키가 안 맞았는지 사람이 바로 고칠 수 있게 적는다 */
function describeKey(evidence: ExpectedEvidence): string {
  const scope = evidence.recommendationNumber
    ? `권고 ${evidence.recommendationNumber}`
    : `섹션 [${(evidence.sectionPath ?? []).join(' > ')}]`;
  return `${evidence.guidelineTitle}(${evidence.publisher}) ${scope}`;
}

@Injectable()
export class LabelResolver {
  constructor(private readonly txManager: TransactionManager) {}

  /**
   * 안정 키를 DB 조인으로 해석한다.
   *
   * **ACTIVE 판본만 본다** — 검색이 ACTIVE만 반환하므로(docs/specs/21), 폐기된 판본을 가리키는
   * 라벨은 정답이 검색에 절대 나타나지 않는 부패한 라벨이다. 조용히 0점 처리하면 「검색이 나쁘다」로
   * 오독되므로 해석 단계에서 끊는다.
   */
  async resolve(
    items: { id: string; expectedEvidence: ExpectedEvidence[] }[],
  ): Promise<ResolvedLabel[]> {
    const resolved: ResolvedLabel[] = [];
    const failures: string[] = [];

    for (const item of items) {
      const chunkIds: string[] = [];
      for (const evidence of item.expectedEvidence) {
        const matched = await this.findChunkIds(evidence);
        if (matched.length === 0) {
          failures.push(`${item.id} → ${describeKey(evidence)}`);
          continue;
        }
        chunkIds.push(...matched);
      }
      resolved.push({ itemId: item.id, chunkIds });
    }

    if (failures.length > 0) {
      throw new LabelResolutionError(
        `라벨 해석 실패 ${failures.length}건 — 코퍼스에 없는 안정 키입니다.\n  ${failures.join('\n  ')}`,
      );
    }
    return resolved;
  }

  private async findChunkIds(evidence: ExpectedEvidence): Promise<string[]> {
    const conditions = [
      eq(guidelines.title, evidence.guidelineTitle),
      eq(guidelines.publisher, evidence.publisher),
      eq(guidelineVersions.status, 'ACTIVE'),
      evidence.recommendationNumber
        ? eq(evidenceChunks.recommendationNumber, evidence.recommendationNumber)
        : undefined,
      evidence.sectionPath ? eq(guidelineSections.path, evidence.sectionPath) : undefined,
    ].filter((c) => c !== undefined);

    const rows = await this.txManager.conn
      .select({ id: evidenceChunks.id })
      .from(evidenceChunks)
      .innerJoin(guidelineSections, eq(evidenceChunks.sectionId, guidelineSections.id))
      .innerJoin(guidelineVersions, eq(evidenceChunks.guidelineVersionId, guidelineVersions.id))
      .innerJoin(guidelines, eq(guidelineVersions.guidelineId, guidelines.id))
      .where(and(...conditions));

    return rows.map((row) => row.id);
  }
}
