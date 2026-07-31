/**
 * 평가셋 로더 (docs/specs/27 수용 기준 3).
 *
 * `approved`만 평가에 포함하고, 스키마 위반은 조용히 거르지 않고 **에러로 거부**한다 —
 * 라벨이 청크를 특정하지 못하는 문항이 섞이면 기준선이 낙관 오염된다.
 */
import { EvalKind, EvalOrigin, EvalSetItem, EvalStatus, ExpectedEvidence } from './evalset.types';

/** 평가셋이 계약을 어겼을 때 — 로더는 이걸 던지고 호출측(CLI)이 비영 종료한다 */
export class EvalSetSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalSetSchemaError';
  }
}

const KINDS: readonly EvalKind[] = ['answerable', 'abstain'];
const STATUSES: readonly EvalStatus[] = ['candidate', 'approved', 'rejected'];
const ORIGINS: readonly EvalOrigin[] = ['reverse-generated', 'manual'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 안정 키 검증. **결손은 두 갈래다** — 지침을 특정하지 못하거나(제목·발행처),
 * 지침 안에서 청크를 특정하지 못하거나(권고번호·섹션경로 둘 다 없음).
 * 둘 중 하나라도 걸리면 그 라벨은 해석될 수 없으므로 로딩 단계에서 끊는다.
 */
function assertStableKey(evidence: unknown, itemId: string, index: number): ExpectedEvidence {
  const at = `${itemId}.expectedEvidence[${index}]`;
  if (!isRecord(evidence)) {
    throw new EvalSetSchemaError(`${at}: 기대 근거가 객체가 아닙니다.`);
  }

  const { guidelineTitle, publisher, recommendationNumber, sectionPath } = evidence;
  if (!nonEmptyString(guidelineTitle)) {
    throw new EvalSetSchemaError(`${at}: guidelineTitle이 없습니다 — 지침을 특정할 수 없습니다.`);
  }
  if (!nonEmptyString(publisher)) {
    throw new EvalSetSchemaError(`${at}: publisher가 없습니다 — 지침을 특정할 수 없습니다.`);
  }

  const hasRecommendation = nonEmptyString(recommendationNumber);
  const hasSectionPath = Array.isArray(sectionPath) && sectionPath.every(nonEmptyString) &&
    sectionPath.length > 0;
  if (!hasRecommendation && !hasSectionPath) {
    throw new EvalSetSchemaError(
      `${at}: recommendationNumber와 sectionPath가 모두 없습니다 — 청크를 특정할 수 없습니다.`,
    );
  }

  return {
    guidelineTitle,
    publisher,
    ...(hasRecommendation ? { recommendationNumber: recommendationNumber as string } : {}),
    ...(hasSectionPath ? { sectionPath: sectionPath as string[] } : {}),
  };
}

function assertItem(raw: unknown, index: number): EvalSetItem {
  if (!isRecord(raw)) {
    throw new EvalSetSchemaError(`평가셋[${index}]: 문항이 객체가 아닙니다.`);
  }

  const { id, kind, question, expectedEvidence, status, origin } = raw;
  if (!nonEmptyString(id)) {
    throw new EvalSetSchemaError(`평가셋[${index}]: id가 없습니다.`);
  }
  if (!KINDS.includes(kind as EvalKind)) {
    throw new EvalSetSchemaError(`${id}: kind가 ${KINDS.join('|')} 중 하나가 아닙니다.`);
  }
  if (!nonEmptyString(question)) {
    throw new EvalSetSchemaError(`${id}: question이 없습니다.`);
  }
  if (!STATUSES.includes(status as EvalStatus)) {
    throw new EvalSetSchemaError(`${id}: status가 ${STATUSES.join('|')} 중 하나가 아닙니다.`);
  }
  if (!ORIGINS.includes(origin as EvalOrigin)) {
    throw new EvalSetSchemaError(`${id}: origin이 ${ORIGINS.join('|')} 중 하나가 아닙니다.`);
  }
  if (!Array.isArray(expectedEvidence)) {
    throw new EvalSetSchemaError(`${id}: expectedEvidence가 배열이 아닙니다.`);
  }

  // abstain은 빈 배열이 정상이다 — 기권해야 하는 질문에는 기대 근거가 없다
  if (kind === 'answerable' && expectedEvidence.length === 0) {
    throw new EvalSetSchemaError(
      `${id}: answerable 문항인데 expectedEvidence가 비어 있습니다 — 정답이 없으면 채점할 수 없습니다.`,
    );
  }

  return {
    id,
    kind: kind as EvalKind,
    question,
    expectedEvidence: expectedEvidence.map((evidence, i) => assertStableKey(evidence, id, i)),
    status: status as EvalStatus,
    origin: origin as EvalOrigin,
  };
}

/**
 * 원시 JSON을 검증해 **평가 대상 문항만** 돌려준다.
 *
 * 검증은 전 문항에 하고 필터는 그 뒤에 한다 — 순서를 뒤집으면 candidate에 섞인 스키마 결함이
 * 승격되는 순간까지 숨는다.
 */
export function loadEvalSet(raw: unknown): EvalSetItem[] {
  if (!Array.isArray(raw)) {
    throw new EvalSetSchemaError('평가셋은 배열이어야 합니다.');
  }
  return raw.map(assertItem).filter((item) => item.status === 'approved');
}
