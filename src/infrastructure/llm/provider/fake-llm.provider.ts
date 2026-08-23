import { Injectable } from '@nestjs/common';
import { LlmAnswerChunk, LlmProvider, LlmStreamRequest } from '../llm-provider.port';

/**
 * 결정적 fake LLM (docs/specs/06 — 실 프로바이더 연동은 docs/specs/13).
 * 검색된 근거의 마커를 인용하는 답변을 생성해, 인용 파이프라인 전체를 키 없이 검증한다.
 * API 키가 하나도 설정되지 않은 환경에서만 등록된다(docs/specs/13 등록 정책).
 *
 * 답변가능성 판정도 방출한다 (docs/specs/40) — 늘 「답할 수 있다」이므로 게이트가 발화하지
 * 않고, 로컬·CI의 기존 동작이 그대로다. 기권 경로는 스위트가 자체 fake로 만든다.
 */
@Injectable()
export class FakeLlmProvider implements LlmProvider {
  readonly name = 'fake-llm';

  async *streamAnswer(request: LlmStreamRequest): AsyncIterable<LlmAnswerChunk> {
    const parts: string[] = [`질문하신 "${request.question}"에 대한 지침 근거 요약입니다. `];
    for (const evidence of request.evidence) {
      parts.push(
        `${evidence.guidelineTitle}의 관련 근거에 따르면, ${headOf(evidence.content)} [${evidence.marker}]. `,
      );
    }
    parts.push('자세한 내용은 인용된 원문을 확인하세요.');

    // 판정은 어떤 델타보다 먼저 온다 (포트 계약, docs/specs/40)
    yield { kind: 'verdict', insufficientEvidence: false, missingAspects: [] };

    for (const part of parts) {
      request.signal?.throwIfAborted();
      yield { kind: 'delta', text: part };
      // 스트리밍 시뮬레이션 (abort 테스트가 개입할 시간 확보)
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
}

function headOf(content: string): string {
  return content.length <= 60 ? content : `${content.slice(0, 60)}…`;
}
