import { familyAPages, noMarkerPages } from '../../../../test/fixtures/nckm-template-samples';
import { SourceDocumentRepository } from '../repository/source-document.repository';
import { GuidelineParseService } from './guideline-parse.service';

const repository = {
  findLatestByExternalId: jest.fn().mockResolvedValue({
    id: 'src-1',
    sourceSystem: 'NCKM',
    externalId: '325',
    title: '가상 지침',
    publisher: '가상기관',
    releaseDate: '2026-07',
    sourceUrl: 'https://example.invalid/guide',
  }),
} as unknown as SourceDocumentRepository;
const service = new GuidelineParseService(repository);

describe('spec 20: 지침 템플릿 실패 가드', () => {
  it('양성 대조군: 정상 fixture는 결과를 반환한다', async () => {
    const result = await service.parse({
      pages: familyAPages,
      externalId: '325',
    });

    expect(result).toBeDefined();
  });

  it('기준 1: 권고문 청크가 없는 번호를 열거하며 던진다', async () => {
    const missingPages = [
      ...familyAPages,
      `58
IV 권고사항
【 R9 】
이 번호는 요약문에서 언급되었지만 뒤에 권고 표나 등급이 없다.`,
    ];

    await expect(
      service.parse({ pages: missingPages, externalId: '325' }),
    ).rejects.toThrow(/R9/);
  });

  it('기준 2: 같은 번호의 권고문 청크가 둘 이상이면 그 번호를 열거하며 던진다', async () => {
    const duplicatedPages = familyAPages.map((page) =>
      page.replace('【 R2 】', '【 R1 】'),
    );

    await expect(
      service.parse({ pages: duplicatedPages, externalId: '325' }),
    ).rejects.toThrow(/R1/);
  });

  it('기준 3: 마커를 하나도 찾지 못하면 비어 있지 않은 메시지로 던진다', async () => {
    await expect(
      service.parse({ pages: noMarkerPages, externalId: '325' }),
    ).rejects.toThrow(/\S/);
  });

  it('기준 4: 등급을 추출하지 못한 권고문 청크 번호를 열거하며 던진다', async () => {
    const gradeMissingPages = familyAPages.map((page) =>
      page
        .replace('A/High', '등급 미기재')
        .replace('B/Low', '등급 미기재'),
    );

    await expect(
      service.parse({ pages: gradeMissingPages, externalId: '325' }),
    ).rejects.toThrow(/R1[\s\S]*R2|R2[\s\S]*R1/);
  });
});
