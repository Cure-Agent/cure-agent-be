import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { RealTimeAlertSender } from '../src/global/observability/real-time-alert.sender';
import { TestErrorsModule } from './fixtures/test-errors.module';

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
    await app.init();
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

  it('검증 실패: VALIDATION_FAILED(422) + 필드 상세, 알림 없음', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/test-errors/validate')
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
      .send({ email: 'doc@clinic.kr', hack: 'x' })
      .expect(200);
    expect(res.body.data).toEqual({ email: 'doc@clinic.kr' });
  });
});
