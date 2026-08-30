// docs/specs/44 BE 수용 기준 9 동결 테스트 — 구현 중 수정 금지

import { translateSectionPath } from './chunk-translator.service';

describe('spec 44: 섹션 경로 원소 대응 번역 계약', () => {
  const path = ['Ⅳ. 권고사항', '1. 합성 침 치료', '가. 적용 조건'];

  it('[기준 9a] 번역된 섹션 경로의 배열 길이는 원문과 같다', async () => {
    const translated = await translateSectionPath(
      path,
      async (segment) => `[translated] ${segment}`,
    );

    expect(translated).not.toBeNull();
    expect(translated).toHaveLength(path.length);
  });

  it('[기준 9b] i번째 번역은 i번째 원문에 대응하고 순서를 바꾸지 않는다', async () => {
    const calls: string[] = [];
    const translated = await translateSectionPath(path, async (segment) => {
      calls.push(segment);
      return `EN(${segment})`;
    });

    expect(calls).toEqual(path);
    expect(translated).toEqual(path.map((segment) => `EN(${segment})`));
  });

  it('[기준 9c] 한 원소라도 번역에 실패하면 절반 번역 대신 전체 null을 반환한다', async () => {
    const translate = jest.fn(async (segment: string) => {
      if (segment === path[1]) {
        throw new Error('spec44 synthetic segment failure');
      }
      return `EN(${segment})`;
    });

    await expect(translateSectionPath(path, translate)).resolves.toBeNull();
    expect(translate).toHaveBeenCalledWith(path[1]);
  });
});
