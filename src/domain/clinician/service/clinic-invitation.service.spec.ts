// docs/specs/35 수용 기준 4·18 동결 테스트 — 구현 중 수정 금지
import { Test } from '@nestjs/testing';
import { clinicInvitationConfig } from '../../../global/config/clinic-invitation.config';
import { ClinicInvitationRepository } from '../repository/clinic-invitation.repository';
import { ClinicInvitationService } from './clinic-invitation.service';

type StoredInvitation = {
  id: string;
  clinicId: string;
  invitedByClinicianId: string;
  tokenHash: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByClinicianId: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const TTL_DAYS = 7;

function exceptionCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as {
    code?: unknown;
    errorCode?: unknown;
    response?: unknown;
    getResponse?: () => unknown;
  };

  if (value.code !== undefined) return value.code;
  if (value.errorCode !== undefined) return value.errorCode;

  const response = typeof value.getResponse === 'function' ? value.getResponse() : value.response;
  if (typeof response !== 'object' || response === null) return undefined;
  return (response as { code?: unknown }).code;
}

function exceptionStatus(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    getStatus?: () => unknown;
    getResponse?: () => unknown;
  };
  if (typeof value.getStatus === 'function') return value.getStatus();
  if (value.status !== undefined) return value.status;
  if (value.statusCode !== undefined) return value.statusCode;
  const response = typeof value.getResponse === 'function' ? value.getResponse() : undefined;
  if (typeof response !== 'object' || response === null) return undefined;
  return (response as { status?: unknown; statusCode?: unknown }).statusCode ??
    (response as { status?: unknown }).status;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('ClinicInvitationService — docs/specs/35 시각 경계', () => {
  let service: ClinicInvitationService;
  let inserted: StoredInvitation | undefined;
  let repository: {
    insert: jest.Mock;
    list: jest.Mock;
    findById: jest.Mock;
    revoke: jest.Mock;
    consume: jest.Mock;
  };

  const principal = {
    clinicianId: 'clinician-owner',
    clinicId: 'clinic-owner',
    sessionId: 'session-owner',
    email: 'owner@unit.test',
    role: 'MEMBER',
  } as unknown as Parameters<ClinicInvitationService['issue']>[0];

  beforeEach(async () => {
    jest.useFakeTimers();
    inserted = undefined;
    repository = {
      insert: jest.fn(async (row: Omit<StoredInvitation, 'acceptedAt' | 'acceptedByClinicianId' | 'revokedAt' | 'createdAt' | 'updatedAt'>) => {
        const now = new Date(Date.now());
        inserted = {
          ...row,
          acceptedAt: null,
          acceptedByClinicianId: null,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        return inserted;
      }),
      list: jest.fn(),
      findById: jest.fn(),
      revoke: jest.fn(),
      consume: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClinicInvitationService,
        { provide: ClinicInvitationRepository, useValue: repository },
        { provide: clinicInvitationConfig.KEY, useValue: { ttlDays: TTL_DAYS } },
      ],
    }).compile();

    service = moduleRef.get(ClinicInvitationService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('기준 4: expiresAt은 주입한 발급 시각 + CLINIC_INVITATION_TTL_DAYS다', async () => {
    const issuedAt = new Date('2032-04-05T06:07:08.901Z');
    jest.setSystemTime(issuedAt);

    await service.issue(principal);

    expect(repository.insert).toHaveBeenCalledTimes(1);
    expect(inserted).toBeDefined();
    expect(inserted?.expiresAt).toEqual(new Date(issuedAt.getTime() + TTL_DAYS * DAY_MS));
  });

  it('기준 18: 같은 유효 토큰은 만료 직전에는 해석되지만 주입한 만료 이후 시각에는 INVITATION_INVALID다', async () => {
    const issuedAt = new Date('2032-04-05T06:07:08.901Z');
    jest.setSystemTime(issuedAt);

    const issued = await service.issue(principal);
    expect(issued.token).toEqual(expect.any(String));
    expect(inserted).toBeDefined();
    if (!inserted) throw new Error('초대 저장 행이 만들어지지 않았습니다.');
    repository.findById.mockResolvedValue(inserted);

    const justBeforeExpiry = new Date(inserted.expiresAt.getTime() - 1);
    await expect(service.resolveForJoin(issued.token, justBeforeExpiry)).resolves.toEqual({
      invitationId: inserted.id,
      clinicId: inserted.clinicId,
    });

    const afterExpiry = new Date(inserted.expiresAt.getTime() + 1);
    const error = await caught(service.resolveForJoin(issued.token, afterExpiry));
    expect(error).toBeDefined();
    expect(exceptionStatus(error)).toBe(404);
    expect(exceptionCode(error)).toBe('INVITATION_INVALID');
  });
});
