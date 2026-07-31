/**
 * 역생성용 청크 샘플링 (docs/specs/27).
 *
 * 지침별 상한을 둬 특정 지침 편중을 막고 **권고 청크를 우선**한다 — 권고는 안정 키
 * (recommendationNumber)로 정확히 특정되지만 비권고는 섹션 경로에 기대야 해서 라벨이 무뎌진다.
 */
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TransactionManager } from '../../global/database/transaction-manager';

export interface SampledChunk {
  chunkId: string;
  content: string;
  guidelineTitle: string;
  publisher: string;
  recommendationNumber: string | null;
  sectionPath: string[];
}

interface SampledRow {
  chunk_id: string;
  content: string;
  guideline_title: string;
  publisher: string;
  recommendation_number: string | null;
  section_path: string[];
}

@Injectable()
export class EvalsetSampler {
  constructor(private readonly txManager: TransactionManager) {}

  /**
   * ACTIVE 판본에서 지침당 최대 `perGuideline`개를 뽑는다.
   *
   * 임베딩 모델로 거르지 않는다 — 질문을 만드는 데에는 본문만 필요하고, 좌표계는 평가 시점의
   * 관심사다. 여기서 걸러버리면 재인제스트 중인 코퍼스에서 평가셋을 못 만든다.
   */
  async sample(perGuideline: number): Promise<SampledChunk[]> {
    const result = await this.txManager.conn.execute(sql`
      SELECT chunk_id, content, guideline_title, publisher, recommendation_number, section_path
      FROM (
        SELECT
          ec.id                AS chunk_id,
          ec.content           AS content,
          g.title              AS guideline_title,
          g.publisher          AS publisher,
          ec.recommendation_number AS recommendation_number,
          gs.path              AS section_path,
          ROW_NUMBER() OVER (
            PARTITION BY g.id
            -- 권고 청크 먼저, 그 안에서는 문서 순서 (재현 가능한 정렬)
            ORDER BY (ec.recommendation_number IS NULL), gs."order", ec."order"
          ) AS rn
        FROM evidence_chunks ec
        JOIN guideline_sections gs ON ec.section_id = gs.id
        JOIN guideline_versions gv ON ec.guideline_version_id = gv.id
        JOIN guidelines g          ON gv.guideline_id = g.id
        WHERE gv.status = 'ACTIVE'
      ) ranked
      WHERE rn <= ${perGuideline}
      ORDER BY guideline_title, rn
    `);

    const rows = (result as unknown as { rows: SampledRow[] }).rows;
    return rows.map((row) => ({
      chunkId: row.chunk_id,
      content: row.content,
      guidelineTitle: row.guideline_title,
      publisher: row.publisher,
      recommendationNumber: row.recommendation_number,
      sectionPath: row.section_path,
    }));
  }

  /** abstain 후보 생성용 — 코퍼스가 «다루는» 주제 목록을 줘야 그 바깥을 물어볼 수 있다 */
  async listGuidelineTitles(): Promise<string[]> {
    const result = await this.txManager.conn.execute(sql`
      SELECT DISTINCT g.title AS title
      FROM guidelines g
      JOIN guideline_versions gv ON gv.guideline_id = g.id
      WHERE gv.status = 'ACTIVE'
      ORDER BY title
    `);
    return (result as unknown as { rows: { title: string }[] }).rows.map((row) => row.title);
  }
}
