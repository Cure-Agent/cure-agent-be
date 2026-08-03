import { Injectable } from '@nestjs/common';
import {
  GuidanceStructureRequest,
  GuidanceStructureResult,
  GuidanceStructurer,
} from './guidance-structurer.port';

/**
 * 결정적 fake 구조화기 (docs/specs/33) — API 키가 없는 환경(e2e·로컬)에서 등록된다.
 * 인용 마커별 1항목, patientFactors는 값이 채워진 임상 필드 전부.
 */
@Injectable()
export class FakeGuidanceStructurer implements GuidanceStructurer {
  readonly model = 'fake-guidance-structurer-v1';

  structure(_request: GuidanceStructureRequest): Promise<GuidanceStructureResult> {
    return Promise.resolve({ considerations: [] });
  }
}
