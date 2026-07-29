// issue #102 수용 기준 동결 테스트 — 구현 중 수정 금지
import {
  GuidelineSourceError,
  SourceListItem,
} from './guideline-source.port';
import { NckmGuidelineSource } from './nckm.source';

function item(externalId: string): SourceListItem {
  return {
    externalId,
    title: `NCKM 지침 ${externalId}`,
    publisher: 'NCKM',
    releaseDate: '2025-01-01',
    sourceUrl: `https://nikom.or.kr/nckm/module/practiceGuide/view.do?guide_idx=${externalId}`,
    fileName: `${externalId}.pdf`,
  };
}

describe('NckmGuidelineSource 다운로드 응답 전달', () => {
  let source: NckmGuidelineSource;

  beforeEach(() => {
    source = new NckmGuidelineSource({
      baseUrl: 'https://nikom.or.kr',
      userAgent: 'test-agent',
      requestIntervalMs: 0,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('HTTP 500 HTML 응답도 예외 없이 본문과 content-type을 그대로 반환한다', async () => {
    const body = Buffer.from('<html><body>첨부 파일이 없습니다.</body></html>');
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(body, {
        status: 500,
        headers: { 'content-type': 'text/html' },
      }),
    );

    await expect(source.download(item('117'))).resolves.toEqual({
      body,
      contentType: 'text/html',
    });
  });

  it('HTTP 500 PDF 응답도 상태로 판정하지 않고 그대로 반환한다', async () => {
    const body = Buffer.from(
      '%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF',
    );
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(body, {
        status: 500,
        headers: { 'content-type': 'application/pdf' },
      }),
    );

    await expect(source.download(item('118'))).resolves.toEqual({
      body,
      contentType: 'application/pdf',
    });
  });

  it('fetch가 reject되면 guide_idx와 원인이 담긴 GuidelineSourceError만 던진다', async () => {
    const networkError = new Error('socket hang up');
    const receivedBody = Buffer.from('not found');
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(
        new Response(receivedBody, {
          status: 404,
          headers: { 'content-type': 'text/plain' },
        }),
      );

    const rejectedDownload = source.download(item('119'));

    await expect(rejectedDownload).rejects.toBeInstanceOf(GuidelineSourceError);
    await expect(rejectedDownload).rejects.toThrow('guide_idx=119');
    await expect(rejectedDownload).rejects.toThrow('socket hang up');

    await expect(source.download(item('120'))).resolves.toEqual({
      body: receivedBody,
      contentType: 'text/plain',
    });
  });
});
