import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { OAuthProviderId } from '../../../infrastructure/oauth/oauth-provider.port';
import { ClinicRow, clinics } from '../persistence/clinic.schema';
import { ClinicianRow, clinicians } from '../persistence/clinician.schema';

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
