// docs/specs/18 수용 기준 8 동결 테스트 — 구현 중 수정 금지
import { SourceListItem } from './guideline-source.port';
import { NckmGuidelineSource } from './nckm.source';

const config = {
  baseUrl: 'https://nckm.test',
  userAgent: 'CureAgent acceptance-test browser UA',
  requestIntervalMs: 0,
};

describe('NckmGuidelineSource', () => {
  afterEach(() => jest.restoreAllMocks());

  it('기준 8: 목록은 rowCount를 사용하고 모든 다운로드에 User-Agent와 해당 문서 Referer를 보낸다', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ rows: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('%PDF-1.7\nfirst', {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('%PDF-1.7\nsecond', {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        }),
      );
    const source = new NckmGuidelineSource(config);
    const items: SourceListItem[] = [
      {
        externalId: '801',
        title: '첫 번째 지침',
        publisher: '첫 번째 기관',
        releaseDate: '2024-07',
        sourceUrl:
          'https://nckm.test/nckm/module/practiceGuide/view.do?guide_idx=801&menu_idx=14',
      },
      {
        externalId: '802',
        title: '두 번째 지침',
        publisher: '두 번째 기관',
        releaseDate: '2023-11',
        sourceUrl:
          'https://nckm.test/nckm/module/practiceGuide/view.do?guide_idx=802&menu_idx=14',
      },
    ];

    await source.listGuidelines();
    for (const sourceItem of items) {
      await source.download(sourceItem);
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [listUrl, listInit] = fetchMock.mock.calls[0];
    expect(listUrl).toBe(
      'https://nckm.test/nckm/module/practiceGuide/jqgridStartMain.do',
    );
    expect(listInit?.method).toBe('POST');
    const listBody = new URLSearchParams(String(listInit?.body));
    expect(listBody.get('rowCount')).toBe('100');
    expect(listBody.has('rows')).toBe(false);

    items.forEach((sourceItem, index) => {
      const [downloadUrl, downloadInit] = fetchMock.mock.calls[index + 1];
      const url = new URL(String(downloadUrl));
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://nckm.test/nckm/module/practiceGuide/download.do',
      );
      expect(url.searchParams.get('guide_idx')).toBe(sourceItem.externalId);
      expect(url.searchParams.get('file_type')).toBe('pdf');

      const headers = new Headers(downloadInit?.headers);
      expect(headers.get('User-Agent')).toBe(config.userAgent);
      expect(headers.get('Referer')).toBe(sourceItem.sourceUrl);
    });
  });
});
