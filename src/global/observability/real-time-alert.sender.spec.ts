// docs/specs/15 수용 기준 1·2·3·4·5·6 동결 테스트 — 구현 중 수정 금지
import {
  type AlertEvent,
  RealTimeAlertSender,
} from './real-time-alert.sender';

const DISCORD = 'https://discord.com/api/webhooks/1/discord-token';
const SLACK = 'https://hooks.slack.com/services/T0/B0/slack-token';
const GENERIC = 'https://alerts.example.internal/hook';

const event: AlertEvent = {
  title: 'LLM provider failure',
  detail: 'upstream request timed out',
  traceId: 'trace-15',
};

describe('RealTimeAlertSender docs/specs/15', () => {
  afterEach(() => jest.restoreAllMocks());

  it('webhookUrls의 Discord와 Slack URL 각각에 정확히 한 번 POST한다', () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const sender = new RealTimeAlertSender({
      webhookUrl: null,
      webhookUrls: [DISCORD, SLACK],
    });

    sender.send(event);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === DISCORD),
    ).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === SLACK)).toHaveLength(
      1,
    );
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).toBe('POST');
    }
  });

  it('Slack·Discord·그 외 호스트에 맞는 JSON 형식으로 분기한다', () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const sender = new RealTimeAlertSender({
      webhookUrl: null,
      webhookUrls: [DISCORD, SLACK, GENERIC],
    });

    sender.send(event);

    const slackCall = fetchMock.mock.calls.find(([url]) => url === SLACK);
    const discordCall = fetchMock.mock.calls.find(([url]) => url === DISCORD);
    const genericCall = fetchMock.mock.calls.find(([url]) => url === GENERIC);
    expect(slackCall).toBeDefined();
    expect(discordCall).toBeDefined();
    expect(genericCall).toBeDefined();

    const slackBody = JSON.parse(String(slackCall?.[1]?.body));
    expect(slackBody.text).toEqual(expect.any(String));
    expect(slackBody.content).toBeUndefined();

    const discordBody = JSON.parse(String(discordCall?.[1]?.body));
    expect(discordBody.content).toEqual(expect.any(String));
    expect(discordBody.text).toBeUndefined();

    const genericBody = JSON.parse(String(genericCall?.[1]?.body));
    expect(genericBody).toEqual(
      expect.objectContaining({
        title: event.title,
        detail: event.detail,
        traceId: event.traceId,
        text: expect.any(String),
      }),
    );
  });

  it('모든 채널의 전송 본문 텍스트에 title·detail·traceId 값을 포함한다', () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const sender = new RealTimeAlertSender({
      webhookUrl: null,
      webhookUrls: [DISCORD, SLACK, GENERIC],
    });

    sender.send(event);

    for (const [url, textKey] of [
      [DISCORD, 'content'],
      [SLACK, 'text'],
      [GENERIC, 'text'],
    ] as const) {
      const call = fetchMock.mock.calls.find(([calledUrl]) => calledUrl === url);
      expect(call).toBeDefined();
      const body = JSON.parse(String(call?.[1]?.body));
      const text = body[textKey];
      expect(text).toEqual(expect.any(String));
      expect(text).toContain(event.title);
      expect(text).toContain(event.detail);
      expect(text).toContain(event.traceId);
    }
  });

  it('같은 title·detail은 5분 동안 채널별로 중복 억제하고 창 경과 후 다시 전송한다', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const sender = new RealTimeAlertSender({
      webhookUrl: null,
      webhookUrls: [DISCORD, SLACK],
    });

    sender.send(event);
    sender.send(event);
    sender.send(event);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === DISCORD),
    ).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === SLACK)).toHaveLength(
      1,
    );

    nowSpy.mockReturnValue(1_000_000 + 6 * 60_000);
    sender.send(event);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === DISCORD),
    ).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => url === SLACK)).toHaveLength(
      2,
    );
  });

  it('첫 채널이 reject해도 다음 채널에 전송하고 send는 예외를 던지지 않는다', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation((url) =>
        url === DISCORD
          ? Promise.reject(new Error('down'))
          : Promise.resolve(new Response('ok', { status: 200 })),
      );
    const sender = new RealTimeAlertSender({
      webhookUrl: null,
      webhookUrls: [DISCORD, SLACK],
    });

    expect(() => sender.send(event)).not.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.find(([url]) => url === SLACK)).toBeDefined();

    await Promise.resolve();
  });

  it('webhookUrls가 빈 배열이면 fetch를 호출하지 않는다', () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const sender = new RealTimeAlertSender({
      webhookUrl: GENERIC,
      webhookUrls: [],
    });

    sender.send(event);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
