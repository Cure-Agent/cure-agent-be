import { Injectable } from '@nestjs/common';
import { LlmProvider, LlmStreamRequest } from './llm-provider.port';

/**
 * 결정적 fake LLM (docs/specs/06 — 실 프로바이더 연동은 spec 07).
 * 검색된 근거의 마커를 인용하는 답변을 생성해, 인용 파이프라인 전체를 키 없이 검증한다.
 */
@Injectable()
export class FakeLlmProvider implements LlmProvider {
  readonly name = 'fake-llm';

  async *streamAnswer(request: LlmStreamRequest): AsyncIterable<string> {
    const parts: string[] = [`질문하신 "${request.question}"에 대한 지침 근거 요약입니다. `];
    for (const evidence of request.evidence) {
      parts.push(
        `${evidence.guidelineTitle}의 관련 근거에 따르면, ${headOf(evidence.content)} [${evidence.marker}]. `,
      );
    }
    parts.push('자세한 내용은 인용된 원문을 확인하세요.');

    for (const part of parts) {
      request.signal?.throwIfAborted();
      yield part;
      // 스트리밍 시뮬레이션 (abort 테스트가 개입할 시간 확보)
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
}

function headOf(content: string): string {
  return content.length <= 60 ? content : `${content.slice(0, 60)}…`;
}
