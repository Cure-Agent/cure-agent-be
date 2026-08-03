import {
  GuidanceStructureResult,
  GuidanceStructurer,
} from './guidance-structurer.port';

/**
 * 킬스위치가 내려간 상태의 구조화기 (docs/specs/33 기준 8).
 *
 * fake로 떨어뜨리지 않는 이유: fake는 **유효한 항목을 만들어내므로** 검증을 통과해
 * `composerVersion='guidance-v2'`로 기록된다 — 프로덕션에서 fake 내용이 활성화되는,
 * 비활성화 의도의 정반대가 된다. 「구조화 안 함」은 별도 구현이어야 성립한다.
 *
 * `structure()`가 던지는 이유: 호출측이 `disabled` 표식 검사를 빠뜨리면 조용히 폴백하는 대신
 * 로그에 남는다. 던져도 `structureWithTimeout`이 null로 접으므로 사용자 영향은 없다.
 */
export class DisabledGuidanceStructurer implements GuidanceStructurer {
  readonly model = 'guidance-structure-disabled';
  readonly disabled = true;

  structure(): Promise<GuidanceStructureResult> {
    throw new Error(
      '참고안 구조화가 비활성화돼 있다 — 호출측이 disabled 표식을 보고 생략해야 한다',
    );
  }
}
