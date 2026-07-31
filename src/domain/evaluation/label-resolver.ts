/**
 * 안정 키 → 실제 청크 해석 (docs/specs/27 수용 기준 4).
 *
 * 해석이 0건이면 그 문항을 **건너뛰지 않고 에러로 끝낸다** — 조용한 스킵은 라벨 부패를 숨기고,
 * 남은 문항만으로 계산된 기준선이 실제보다 좋아 보이게 만든다.
 */
import { Injectable } from '@nestjs/common';
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

@Injectable()
export class LabelResolver {
  /**
   * TODO(docs/specs/27 기준 4): 안정 키를 DB 조인으로 해석한다.
   * 0건 매칭이면 실패 문항 id와 키를 실어 LabelResolutionError를 던진다.
   */
  resolve(_items: { id: string; expectedEvidence: ExpectedEvidence[] }[]): Promise<ResolvedLabel[]> {
    return Promise.reject(new Error('TODO: docs/specs/27 기준 4 미구현'));
  }
}
