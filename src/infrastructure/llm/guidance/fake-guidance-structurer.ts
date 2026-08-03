import { Injectable } from '@nestjs/common';
import {
  GuidanceStructureRequest,
  GuidanceStructureResult,
  GuidanceStructurer,
} from './guidance-structurer.port';

const EXCERPT_LENGTH = 80;

/**
 * 결정적 fake 구조화기 (docs/specs/33) — API 키가 없는 환경(e2e·로컬)에서 등록된다.
 * 인용 마커별 1항목, patientFactors는 값이 채워진 임상 필드 전부.
 *
 * 프로필 필드가 하나도 없으면 두 다리를 채우지 못한 항목만 나오고, 검증기가 전부 폐기해
 * 결정적 조립으로 되돌아간다 — 임상 정보가 비어 있는 환자에서 폴백으로 열화하는 것이 옳다.
 */
@Injectable()
export class FakeGuidanceStructurer implements GuidanceStructurer {
  readonly model = 'fake-guidance-structurer-v1';

  structure(request: GuidanceStructureRequest): Promise<GuidanceStructureResult> {
    const patientFactors = request.profileFields.map((field) => field.field);

    return Promise.resolve({
      considerations: request.evidence.map((item) => ({
        title:
          item.sectionPath.length > 0
            ? `${item.guidelineTitle} — ${item.sectionPath.join(' > ')}`
            : item.guidelineTitle,
        rationale: `${excerpt(item.content)} 이 환자의 기록된 항목과 대조해 적용 여부를 검토하세요.`,
        applicability: 'CAUTION',
        markers: [item.marker],
        patientFactors,
      })),
    });
  }
}

function excerpt(content: string): string {
  return content.length <= EXCERPT_LENGTH ? content : `${content.slice(0, EXCERPT_LENGTH)}…`;
}
