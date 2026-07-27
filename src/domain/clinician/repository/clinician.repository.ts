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
