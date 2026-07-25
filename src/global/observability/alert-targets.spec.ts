// docs/specs/15 수용 기준 7 동결 테스트 — 구현 중 수정 금지
import { resolveAlertTargets } from './alert-targets';

describe('resolveAlertTargets', () => {
  it('ALERT_WEBHOOK_URL만 있으면 해당 URL 하나를 반환한다', () => {
    expect(
      resolveAlertTargets({
        ALERT_WEBHOOK_URL: 'https://legacy.example/hook',
      }),
    ).toEqual(['https://legacy.example/hook']);
  });

  it('ALERT_WEBHOOK_URLS를 쉼표로 나누고 공백을 트림한다', () => {
    expect(resolveAlertTargets({ ALERT_WEBHOOK_URLS: 'a, b' })).toEqual([
      'a',
      'b',
    ]);
  });

  it('두 변수가 겹치면 ALERT_WEBHOOK_URLS 순서를 우선해 중복 제거한다', () => {
    expect(
      resolveAlertTargets({
        ALERT_WEBHOOK_URLS: 'a, b',
        ALERT_WEBHOOK_URL: 'b',
      }),
    ).toEqual(['a', 'b']);
  });

  it('두 변수가 모두 없으면 빈 배열을 반환한다', () => {
    expect(resolveAlertTargets({})).toEqual([]);
  });
});
