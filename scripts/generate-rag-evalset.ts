/**
 * 평가셋 역생성 CLI (docs/specs/27).
 * 사용법: `pnpm evalset:generate [지침당_청크수] [기권_문항수]` → .cure-data/rag-evalset-candidates.json
 *
 * 산출물은 전부 `status: 'candidate'`다 — 사람 검수를 거쳐 `approved`로 승격된 것만
 * test/fixtures/rag-eval/evalset.json에 들어가고, 로더가 그것만 평가에 넣는다(기준 3).
 *
 * 서빙 LLM 포트(LlmProvider.streamAnswer)를 재사용하지 않는다 — 근거 인용 답변 전용 계약이고,
 * 오프라인 도구에 §11 4단 방어는 불필요하다(실패의 복구는 재실행이다).
 */
import { NestFactory } from '@nestjs/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppModule } from '../src/app.module';
import { EvalsetSampler, SampledChunk } from '../src/domain/evaluation/evalset-sampler';
import { EvalSetItem } from '../src/domain/evaluation/evalset.types';

const OUTPUT = '.cure-data/rag-evalset-candidates.json';
const DEFAULT_PER_GUIDELINE = 1;
const DEFAULT_ABSTAIN_COUNT = 15;

/**
 * 역생성 질문은 원본 청크와 어휘를 공유해 검색이 실제보다 쉬워지는 **낙관 편향**이 있다.
 * 그래서 문장 복사를 금지하고 임상 현장의 표현을 요구한다 — 그래도 편향이 남으므로 검수가 관문이다.
 */
const ANSWERABLE_SYSTEM = [
  '당신은 한의 임상 지침으로 평가셋을 만드는 도구입니다.',
  '주어진 지침 본문을 근거로 **의료인이 실제로 물을 법한 질문 1개**를 만듭니다.',
  '규칙:',
  '1. 본문의 문장을 그대로 베끼지 않는다 — 표현을 임상 현장의 말로 바꾼다.',
  '2. 본문만 보고 답할 수 있는 질문이어야 한다.',
  '3. 한 문장, 물음표로 끝낸다.',
  '4. 질문 텍스트만 출력한다. 번호·따옴표·설명을 붙이지 않는다.',
].join('\n');

const ABSTAIN_SYSTEM = [
  '당신은 검색 시스템의 **기권 능력**을 시험할 질문을 만드는 도구입니다.',
  '주어진 목록은 코퍼스가 다루는 지침 주제입니다.',
  '규칙:',
  '1. 목록의 어느 지침으로도 답할 수 없는 **인접 임상 질문**을 만든다.',
  '2. 그럼에도 한의·의료 맥락은 유지한다 — 완전히 무관한 잡담은 시험이 되지 않는다.',
  '3. 목록의 지침이 **부분적으로라도 다루는 소재**(동반 증상·이상반응·감별진단 포함)는 피한다 —',
  '   답할 수 있는 질문에 기권 라벨이 붙으면 지표가 거꾸로 오염된다.',
  '4. 「코퍼스에 없는」처럼 평가 장치를 가리키는 말을 쓰지 않는다 — 임상의의 실제 질문이어야 한다.',
  '5. 한 문장, 물음표로 끝낸다.',
  '6. 질문 텍스트만 출력한다.',
].join('\n');

/**
 * 이미 만든 질문을 회차마다 실어 **주제 반복을 막는다** (#228 실측).
 * 회차 번호만 다른 독립 호출은 같은 응급 주제(충수염·심근경색)로 수렴해,
 * 40건 생성분의 절반이 서로 중복이었다 — 모델은 앞 회차를 기억하지 못한다.
 */
function abstainUserPrompt(topicList: string, previous: string[], index: number): string {
  const avoid = previous.length
    ? `\n\n이미 만든 질문(주제·소재가 겹치지 않게 하세요):\n${previous.map((q) => `- ${q}`).join('\n')}`
    : '';
  return (
    `코퍼스가 다루는 주제:\n${topicList}\n\n` +
    `(${index + 1}번째 질문 — 앞서 만든 것과 다른 임상 영역을 고르세요)${avoid}`
  );
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

async function askOnce(system: string, user: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY가 없습니다 — 역생성에는 실 LLM이 필요합니다.');
  const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const model = process.env.OPENAI_MODEL ?? 'gpt-5.4-mini';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const payload = (await response.json()) as ChatResponse;
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI 응답에 질문이 없습니다.');
  return text;
}

/** 검수자가 질문과 원본을 대조할 수 있어야 한다 — 근거 없이는 승격 판단이 불가능하다 */
interface CandidateItem extends EvalSetItem {
  sourceExcerpt?: string;
}

function toAnswerableCandidate(chunk: SampledChunk, question: string, index: number): CandidateItem {
  return {
    id: `evalgen-answerable-${String(index + 1).padStart(3, '0')}`,
    kind: 'answerable',
    question,
    expectedEvidence: [
      {
        guidelineTitle: chunk.guidelineTitle,
        publisher: chunk.publisher,
        // 권고 청크는 권고번호로, 비권고는 섹션 경로로 특정한다 (chunk ID는 재인제스트에 갈린다)
        ...(chunk.recommendationNumber
          ? { recommendationNumber: chunk.recommendationNumber }
          : { sectionPath: chunk.sectionPath }),
      },
    ],
    status: 'candidate',
    origin: 'reverse-generated',
    sourceExcerpt: chunk.content.slice(0, 400),
  };
}

async function main(): Promise<void> {
  const perGuideline = Number(process.argv[2] ?? DEFAULT_PER_GUIDELINE);
  const abstainCount = Number(process.argv[3] ?? DEFAULT_ABSTAIN_COUNT);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const candidates: CandidateItem[] = [];
  try {
    const sampler = app.get(EvalsetSampler);
    const chunks = await sampler.sample(perGuideline);
    const titles = await sampler.listGuidelineTitles();
    if (chunks.length === 0) throw new Error('ACTIVE 판본 청크가 없습니다 — 먼저 인제스트하세요.');

    console.error(`샘플 ${chunks.length}건 / 지침 ${titles.length}종 — 역생성 시작`);

    for (const [index, chunk] of chunks.entries()) {
      const question = await askOnce(
        ANSWERABLE_SYSTEM,
        `지침: ${chunk.guidelineTitle}\n섹션: ${chunk.sectionPath.join(' > ')}\n본문:\n${chunk.content}`,
      );
      candidates.push(toAnswerableCandidate(chunk, question, index));
      console.error(`  answerable ${index + 1}/${chunks.length}`);
    }

    const topicList = titles.map((title) => `- ${title}`).join('\n');
    const previousAbstain: string[] = [];
    for (let index = 0; index < abstainCount; index += 1) {
      const question = await askOnce(
        ABSTAIN_SYSTEM,
        abstainUserPrompt(topicList, previousAbstain, index),
      );
      previousAbstain.push(question);
      candidates.push({
        id: `evalgen-abstain-${String(index + 1).padStart(3, '0')}`,
        kind: 'abstain',
        question,
        expectedEvidence: [],
        status: 'candidate',
        origin: 'reverse-generated',
      });
      console.error(`  abstain ${index + 1}/${abstainCount}`);
    }
  } finally {
    await app.close();
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(candidates, null, 2)}\n`, 'utf8');
  console.error(
    `\n${OUTPUT}에 ${candidates.length}건을 썼습니다. 전부 status=candidate입니다.\n` +
      '검수 후 approved로 바꾼 항목만 test/fixtures/rag-eval/evalset.json으로 옮기세요 —\n' +
      '검수 기준: (1) 임상의가 할 법한 표현인가 (2) 본문을 베끼지 않았는가 (3) 기대 근거가 정말 그 질문의 답인가.',
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
