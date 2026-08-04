import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { OAuthProviderId } from '../../../infrastructure/oauth/oauth-provider.port';
import { ClinicRow, clinics } from '../persistence/clinic.schema';
import { ClinicianRow, clinicians } from '../persistence/clinician.schema';

/** tombstone 표시 이름 — 목록에서는 제외되므로 감사 조회에서만 보인다 (docs/specs/36) */
export const WITHDRAWN_DISPLAY_NAME = '탈퇴한 사용자';

@Injectable()
export class ClinicianRepository {
  constructor(private readonly txManager: TransactionManager) {}

  async insertClinic(row: Pick<ClinicRow, 'id' | 'name'>): Promise<void> {
    await this.txManager.conn.insert(clinics).values(row);
  }

  async insertClinician(
    row: Pick<
      ClinicianRow,
      | 'id'
      | 'clinicId'
      | 'email'
      | 'oauthProvider'
      | 'oauthProviderId'
      | 'displayName'
      | 'licenseNumberEncrypted'
    >,
  ): Promise<void> {
    await this.txManager.conn.insert(clinicians).values(row);
  }

  /**
   * 개설자 지정 (docs/specs/35). clinic → clinician 순환 참조라 clinic insert 시점에는
   * 아직 clinician이 없다 — 만들고 나서 이 UPDATE로 채운다.
   */
  async updateClinicOwner(clinicId: string, ownerClinicianId: string): Promise<void> {
    await this.txManager.conn
      .update(clinics)
      .set({ ownerClinicianId })
      .where(eq(clinics.id, clinicId));
  }

  /** 초대 권한 판정용 (docs/specs/35) — 역할과 달리 병원 단위 권한이라 clinics에서 읽는다 */
  async findClinicOwnerId(clinicId: string): Promise<string | null> {
    const rows = await this.txManager.conn
      .select({ ownerClinicianId: clinics.ownerClinicianId })
      .from(clinics)
      .where(eq(clinics.id, clinicId))
      .limit(1);
    return rows[0]?.ownerClinicianId ?? null;
  }

  /** 구성원 목록 (docs/specs/36) — tombstone은 제외한다. 클리닉당 소수라 커서를 두지 않는다 */
  async listMembers(clinicId: string): Promise<ClinicianRow[]> {
    return this.txManager.conn
      .select()
      .from(clinicians)
      .where(and(eq(clinicians.clinicId, clinicId), isNull(clinicians.deletedAt)))
      .orderBy(asc(clinicians.createdAt), asc(clinicians.id));
  }

  /** 살아 있는 구성원 수 — 「마지막 구성원인가」 판정 (docs/specs/36) */
  async countActiveMembers(clinicId: string): Promise<number> {
    const rows = await this.txManager.conn
      .select({ total: count() })
      .from(clinicians)
      .where(and(eq(clinicians.clinicId, clinicId), isNull(clinicians.deletedAt)));
    return rows[0]?.total ?? 0;
  }

  /** 이양 대상 검증용 — 같은 클리닉의 **살아 있는** 구성원만 찾는다 (§4.4 스코프) */
  async findMemberInClinic(clinicId: string, id: string): Promise<ClinicianRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(clinicians)
      .where(
        and(
          eq(clinicians.id, id),
          eq(clinicians.clinicId, clinicId),
          isNull(clinicians.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * tombstone 익명화 (docs/specs/36) — 행은 남기고 개인정보만 덮는다.
   *
   * `email`·`oauthProviderId`는 unique라 비울 수 없어 **id를 섞은 결정적 값**으로 덮는다.
   * 부수 효과로 같은 소셜 계정의 재로그인이 신규 가입 흐름을 타게 되어(§4.2 계정 동일성이
   * provider+providerId다) 재가입이 자연히 열린다.
   */
  async anonymize(id: string, at: Date): Promise<void> {
    await this.txManager.conn
      .update(clinicians)
      .set({
        email: `deleted-${id}@deleted.invalid`,
        oauthProviderId: `deleted-${id}`,
        displayName: WITHDRAWN_DISPLAY_NAME,
        licenseNumberEncrypted: '',
        deletedAt: at,
      })
      .where(and(eq(clinicians.id, id), isNull(clinicians.deletedAt)));
  }

  /** 마지막 구성원이 떠난 클리닉의 파기 예약 (docs/specs/36) — §34와 같이 덮지 않는다 */
  async softDeleteClinic(clinicId: string, at: Date): Promise<void> {
    await this.txManager.conn
      .update(clinics)
      .set({ deletedAt: at })
      .where(and(eq(clinics.id, clinicId), isNull(clinics.deletedAt)));
  }

  async existsByEmail(email: string): Promise<boolean> {
    const rows = await this.txManager.conn
      .select({ id: clinicians.id })
      .from(clinicians)
      .where(eq(clinicians.email, email))
      .limit(1);
    return rows.length > 0;
  }

  /** 소셜 계정 동일성 판정 (docs/specs/17) — 이메일이 아니라 provider+providerId가 기준이다. */
  async findByOAuthAccount(
    provider: OAuthProviderId,
    providerId: string,
  ): Promise<{ clinician: ClinicianRow; clinic: ClinicRow } | null> {
    const rows = await this.txManager.conn
      .select({ clinician: clinicians, clinic: clinics })
      .from(clinicians)
      .innerJoin(clinics, eq(clinicians.clinicId, clinics.id))
      .where(
        and(
          eq(clinicians.oauthProvider, provider),
          eq(clinicians.oauthProviderId, providerId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** 역할만 필요한 가드 경로 — 토큰에 박지 않고 요청당 조회한다 (docs/specs/21) */
  async findRoleById(id: string): Promise<ClinicianRow['role'] | null> {
    const rows = await this.txManager.conn
      .select({ role: clinicians.role })
      .from(clinicians)
      .where(eq(clinicians.id, id))
      .limit(1);
    return rows[0]?.role ?? null;
  }

  async findById(id: string): Promise<{ clinician: ClinicianRow; clinic: ClinicRow } | null> {
    const rows = await this.txManager.conn
      .select({ clinician: clinicians, clinic: clinics })
      .from(clinicians)
      .innerJoin(clinics, eq(clinicians.clinicId, clinics.id))
      .where(eq(clinicians.id, id))
      .limit(1);
    return rows[0] ?? null;
  }
}
