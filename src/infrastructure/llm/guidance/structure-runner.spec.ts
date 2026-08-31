// docs/specs/33 수용 기준 4 동결 테스트 — 구현 중 수정 금지

import type {
  GuidanceStructureInput,
  GuidanceStructureResult,
  GuidanceStructurer,
} from './guidance-structurer.port';
import {
  GUIDANCE_STRUCTURE_TIMEOUT_MS,
  structureWithTimeout,
} from './structure-runner';

const input: GuidanceStructureInput = {
  answerText: '만성 요통에는 침 치료를 권고합니다 [1].',
  evidence: [
    {
      marker: 1,
      content: '만성 요통 환자에게 통증 감소와 기능 개선을 위해 침 치료를 권고한다.',
      guidelineTitle: '요통 진료지침',
      sectionPath: ['치료', '침치료'],
    },
  ],
  profileFields: [{ field: '진단명', value: '만성 요통' }],
  // docs/specs/44가 입력에 언어를 추가했다 — 이 스위트는 상한·폴백만 재므로 값은 무관하다
  lang: 'ko',
};

const structuredResult: GuidanceStructureResult = {
  considerations: [
    {
      title: '침 치료 적용',
      rationale: '근거의 대상과 환자의 진단명이 일치합니다.',
      applicability: 'APPLICABLE',
      markers: [1],
      patientFactors: ['진단명'],
    },
  ],
};

const resolvedStructurer = (
  result: GuidanceStructureResult = structuredResult,
): GuidanceStructurer => ({
  model: 'resolved-structurer-test',
  structure: jest.fn(() => Promise.resolve(result)),
});

describe('spec 33: guidance structure 호출 상한과 폴백', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('기준 4a: 상한 안에 완료한 구조화 결과를 null로 바꾸지 않고 그대로 반환한다', async () => {
    const structurer = resolvedStructurer();

    await expect(
      structureWithTimeout(structurer, input, { timeoutMs: 500 }),
    ).resolves.toBe(structuredResult);
    expect(structurer.structure).toHaveBeenCalledTimes(1);
  });

  it('기준 4b: 응답하지 않는 구조화기는 지정 상한이 지난 뒤 null로 폴백한다', async () => {
    const structurer: GuidanceStructurer = {
      model: 'pending-structurer-test',
      structure: jest.fn(
        () => new Promise<GuidanceStructureResult>(() => undefined),
      ),
    };

    const pending = structureWithTimeout(structurer, input, {
      timeoutMs: 1_250,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await jest.advanceTimersByTimeAsync(1_249);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(structurer.structure).toHaveBeenCalledTimes(1);
  });

  it('기준 4c-1: 구조화기가 동기 예외를 던져도 호출측으로 새지 않고 null을 반환한다', async () => {
    const structurer: GuidanceStructurer = {
      model: 'throwing-structurer-test',
      structure: jest.fn(() => {
        throw new Error('의도된 동기 구조화 오류');
      }),
    };

    await expect(structureWithTimeout(structurer, input)).resolves.toBeNull();
    expect(structurer.structure).toHaveBeenCalledTimes(1);
  });

  it('기준 4c-2: 구조화기가 reject해도 호출측으로 새지 않고 null을 반환한다', async () => {
    const structurer: GuidanceStructurer = {
      model: 'rejecting-structurer-test',
      structure: jest.fn(() =>
        Promise.reject(new Error('의도된 비동기 구조화 오류')),
      ),
    };

    await expect(structureWithTimeout(structurer, input)).resolves.toBeNull();
    expect(structurer.structure).toHaveBeenCalledTimes(1);
  });

  it('기준 4d: 기본 호출 상한은 정확히 20초이며 실제 성공 호출을 함께 통과시킨다', async () => {
    expect(GUIDANCE_STRUCTURE_TIMEOUT_MS).toBe(20_000);

    const structurer = resolvedStructurer();
    await expect(structureWithTimeout(structurer, input)).resolves.toBe(
      structuredResult,
    );
    expect(structurer.structure).toHaveBeenCalledTimes(1);
  });
});
