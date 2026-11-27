import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { RealTimeAlertSender } from '../src/global/observability/real-time-alert.sender';
import { TestErrorsModule } from './fixtures/test-errors.module';
import { bootstrapApp } from './fixtures/app-bootstrap';

describe('global 기반 (봉투·traceId·예외 필터·검증)', () => {
  let app: INestApplication;
  const alertSender = { send: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, TestErrorsModule],
    })
      .overrideProvider(RealTimeAlertSender)
      .useValue(alertSender)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1'); // main.ts와 동일 구성
    app.use(cookieParser());
    await bootstrapApp(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    alertSender.send.mockClear();
  });

  it('성공 응답: 봉투 형식 + traceId 헤더/바디 일치', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);

    expect(res.body).toMatchObject({
      success: true,
      code: 'SUCCESS',
      message: '요청에 성공하였습니다.',
      data: { status: 'ok' },
      page: null,
    });
    expect(res.body.traceId).not.toHaveLength(0);
    expect(res.headers['x-trace-id']).toBe(res.body.traceId);
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
  });

  it('요청마다 traceId가 다르다', async () => {
    const [a, b] = await Promise.all([
      request(app.getHttpServer()).get('/api/v1/health'),
      request(app.getHttpServer()).get('/api/v1/health'),
    ]);
    expect(a.body.traceId).not.toBe(b.body.traceId);
  });

  it('미지정 라우트: NOT_FOUND 봉투(404)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(res.body).toMatchObject({ success: false, code: 'NOT_FOUND', data: null });
    expect(alertSender.send).not.toHaveBeenCalled();
  });

  it('ServiceException: 레지스트리 status(409) + 보조 data, 알림 없음', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/test-errors/conflict').expect(409);
    expect(res.body).toMatchObject({
      success: false,
      code: 'PATIENT_VERSION_CONFLICT',
      message: '다른 사용자가 환자 정보를 먼저 수정했습니다.',
      data: { currentVersion: 4 },
    });
    expect(res.headers['x-trace-id']).toBe(res.body.traceId);
    expect(alertSender.send).not.toHaveBeenCalled();
  });

  it('예상 밖 예외: INTERNAL_ERROR(500) + 실시간 알림 1회', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/test-errors/boom').expect(500);
    expect(res.body).toMatchObject({ success: false, code: 'INTERNAL_ERROR', data: null });
    expect(alertSender.send).toHaveBeenCalledTimes(1);
    expect(alertSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'INTERNAL_ERROR', traceId: res.body.traceId }),
    );
  });

  describe('우리 에러 모델 밖의 4xx: BAD_REQUEST(400) 봉투, 알림 없음 (#563)', () => {
    // 봉투는 공통 코드로 묶이므로 원래 status·사유는 warn 로그에만 남는다.
    // TestingLogger는 warn 출력을 버리므로 호출 자체를 본다
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn');
    });
    afterEach(() => {
      warn.mockRestore();
    });

    // 본문 파서는 라우팅 전에 모든 경로에서 돈다 — 운영에서 스캐너가 보낸 경로(`/`)를 그대로 쓴다
    const parserRejections: Array<
      [label: string, encoding: string | undefined, body: string, originalStatus: number]
    > = [
      ['지원하지 않는 Content-Encoding(415)', 'x', '{}', 415],
      ['압축 해제 실패 — br 헤더에 Brotli가 아닌 본문(400)', 'br', '{"not":"brotli"}', 400],
      ['본문 한도 100KB 초과(413)', undefined, JSON.stringify({ pad: 'a'.repeat(200_000) }), 413],
    ];

    it.each(parserRejections)('본문 파서: %s', async (_label, encoding, body, originalStatus) => {
      const req = request(app.getHttpServer()).post('/').set('Content-Type', 'application/json');
      if (encoding) req.set('Content-Encoding', encoding);

      const res = await req.send(body).expect(400);
      expect(res.body).toMatchObject({ success: false, code: 'BAD_REQUEST', data: null });
      expect(alertSender.send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`요청 거부(${originalStatus})`));
    });

    // Jest VM 안에서는 zlib(Node 코어)이 만든 Error가 instanceof Error를 통과하지 못해, http-errors가 원본 대신
    // 새 400 객체를 만든다(메시지 「Bad Request」). 운영에서는 원본 Error에 status·expose가 덧씌워진 채 온다.
    // 그 모양은 위 경로로 재현되지 않으므로 따로 고정한다
    it('http-errors가 덧씌운 일반 Error(운영의 「Decompression failed」 모양)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/test-errors/http-error-4xx')
        .expect(400);
      expect(res.body).toMatchObject({ success: false, code: 'BAD_REQUEST', data: null });
      expect(alertSender.send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('요청 거부(400): Decompression failed'),
      );
    });

    it('매핑 없는 4xx HttpException(413)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/test-errors/payload-too-large')
        .expect(400);
      expect(res.body).toMatchObject({ success: false, code: 'BAD_REQUEST', data: null });
      expect(alertSender.send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('요청 거부(413)'));
    });
  });

  it.each([
    ['upstream-status', 'status·statusCode만 있고 expose가 없는 4xx(상류 응답 모양)'],
    ['http-error-5xx', 'http-errors 모양의 5xx'],
  ])('양성 대조 — %s: %s는 INTERNAL_ERROR(500) + 알림 1회', async (path) => {
    const res = await request(app.getHttpServer()).get(`/api/v1/test-errors/${path}`).expect(500);
    expect(res.body).toMatchObject({ success: false, code: 'INTERNAL_ERROR', data: null });
    expect(alertSender.send).toHaveBeenCalledTimes(1);
  });

  it('CSRF: 상태 변경 요청에 커스텀 헤더가 없으면 403 CSRF_REJECTED', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/test-errors/validate')
      .send({ email: 'doc@clinic.kr' })
      .expect(403);
    expect(res.body.code).toBe('CSRF_REJECTED');
  });

  it('검증 실패: VALIDATION_FAILED(422) + 필드 상세, 알림 없음', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/test-errors/validate')
      .set('X-CSRF-Protection', '1')
      .send({ email: 'not-an-email' })
      .expect(422);

    expect(res.body).toMatchObject({ success: false, code: 'VALIDATION_FAILED' });
    expect(res.body.data.errors).toEqual([
      expect.objectContaining({ field: 'email', constraints: expect.any(Array) }),
    ]);
    expect(alertSender.send).not.toHaveBeenCalled();
  });

  it('whitelist: 계약에 없는 필드는 제거된다', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/test-errors/validate')
      .set('X-CSRF-Protection', '1')
      .send({ email: 'doc@clinic.kr', hack: 'x' })
      .expect(200);
    expect(res.body.data).toEqual({ email: 'doc@clinic.kr' });
  });

  it('보호 라우트: 토큰 없으면 401 UNAUTHORIZED', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('X-CSRF-Protection', '1')
      .expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});
