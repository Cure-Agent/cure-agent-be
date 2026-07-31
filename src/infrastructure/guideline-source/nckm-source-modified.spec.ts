// docs/specs/26 기준 5 동결 테스트 — 목록 날짜 문자열은 파싱하지 않는다.
import { type SourceListItem } from './guideline-source.port';
import { NckmGuidelineSource } from './nckm.source';

const config = {
  baseUrl: 'https://nckm.test',
  userAgent: 'CureAgent revision-scan acceptance-test UA',
  requestIntervalMs: 0,
};

describe('NckmGuidelineSource 목록 수정일 매핑', () => {
  afterEach(() => jest.restoreAllMocks());

  it('기준 5a·5b·5c: modify_date 원문을 우선하고, 없으면 add_date로 대체하며, 둘 다 없으면 비워 둔다', async () => {
    const modifiedAt = 'Jul 30, 2026 10:05:00 AM';
    const addedAt = 'Jul 29, 2026 02:17:00 PM';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rows: [
            {
              guide_idx: 'synthetic-modified',
              title: '합성 수정일 우선 지침',
              agency: '가상별빛학회',
              release_date: '2026-08',
              guide_file: 'synthetic-modified.pdf',
              modify_date: modifiedAt,
              add_date: 'Jul 01, 2026 09:00:00 AM',
            },
            {
              guide_idx: 'synthetic-added',
              title: '합성 등록일 대체 지침',
              agency: '가상별빛학회',
              release_date: '2026-08',
              guide_file: 'synthetic-added.pdf',
              modify_date: null,
              add_date: addedAt,
            },
            {
              guide_idx: 'synthetic-undated',
              title: '합성 날짜 미상 지침',
              agency: '가상별빛학회',
              release_date: '2026-08',
              guide_file: 'synthetic-undated.pdf',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const source = new NckmGuidelineSource(config);
    const items: SourceListItem[] = await source.listGuidelines();
    const byId = new Map(items.map((item) => [item.externalId, item]));

    expect(items).toHaveLength(3);
    // 이 양성 단언들이 현재 `sourceModifiedAt: null` 스텁을 반드시 죽인다.
    expect(byId.get('synthetic-modified')?.sourceModifiedAt).toBe(modifiedAt);
    expect(byId.get('synthetic-added')?.sourceModifiedAt).toBe(addedAt);
    // 기계적 수정: toBeNullish는 Jest에 없는 matcher다. 의미(null 또는 undefined)는 그대로 둔다
    expect(byId.get('synthetic-undated')?.sourceModifiedAt ?? null).toBeNull();
  });
});
