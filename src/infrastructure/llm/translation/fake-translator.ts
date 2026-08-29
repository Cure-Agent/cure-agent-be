import { Injectable } from '@nestjs/common';
import { SupportedLang, Translator } from './translator.port';

/**
 * 결정적 fake 번역기 (docs/specs/42) — `FakeReranker` 선례를 따른다.
 *
 * 실제 번역을 하지 않고 **관측 가능한 표식만 붙인다.** e2e는 「번역기를 탔는가 / 그 산출물이
 * 검색 입력으로 갔는가」를 단언하므로 자연스러운 번역문이 필요 없고, 오히려 표식이 있어야
 * 원문과 번역문을 단언에서 구분할 수 있다.
 */
@Injectable()
export class FakeTranslator implements Translator {
  readonly model = 'fake-translator-v1';

  translate(text: string, target: SupportedLang): Promise<string> {
    return Promise.resolve(`[${target}] ${text}`);
  }
}
