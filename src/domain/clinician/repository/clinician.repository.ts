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
   * **비우지 않고 id를 섞은 결정적 값으로 덮는 이유는 파기 의무 때문이다.** `oauthProviderId`는
   * `uq_clinicians_oauth`가 걸려 있어 값을 비울 수도 없다 — 다만 `email`의 unique는 §37에서
   * 사라졌으므로 이제 제약 회피가 아니라 **개인정보를 남기지 않기 위해** 덮는다(동작은 불변).
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

  /**
   * 강퇴 — 소속만 끊는다 (docs/specs/38). 개인정보는 건드리지 않는다: 계정도 그 안의 정보도
   * 그 사람의 것이므로 개설자가 파기하지 않는다(§36 탈퇴와 갈리는 지점이다).
   *
   * 자기 클리닉 소속인 동안에만 성립하는 조건부 UPDATE다 — 0행이면 그 사이 누가 먼저 뺐거나
   * 애초에 타 클리닉이며, 호출측은 둘을 구분하지 않고 404로 수렴시킨다 (§4.4).
   */
  async detachFromClinic(clinicId: string, id: string): Promise<boolean> {
    const rows = await this.txManager.conn
      .update(clinicians)
      .set({ clinicId: null })
      .where(
        and(
          eq(clinicians.id, id),
          eq(clinicians.clinicId, clinicId),
          isNull(clinicians.deletedAt),
        ),
      )
      .returning({ id: clinicians.id });
    return rows.length > 0;
  }

  /**
   * 재온보딩 — 무소속 계정에 클리닉을 붙인다 (docs/specs/38).
   *
   * insert가 아니라 UPDATE인 이유는 `uq_clinicians_oauth`가 계정 동일성의 유일한 제약이기
   * 때문이다(§37) — 같은 소셜 계정으로 새 행을 만들면 unique 위반이다. 그래서 `id`·`email`·
   * `oauthProvider`·`oauthProviderId`·`role`은 **건드리지 않는다**.
   *
   * `clinic_id IS NULL` 조건이 핵심이다: 티켓이 둘 발급된 뒤 하나가 이미 소비됐다면 두 번째
   * 티켓은 0행이 되어 막힌다. 없으면 **이미 소속된 계정을 조용히 다른 클리닉으로 옮기는**
   * 소속 이동이 되어 §35·§38이 함께 막은 경로가 뒷문으로 열린다.
   */
  async attachToClinic(
    row: Pick<ClinicianRow, 'id' | 'displayName' | 'licenseNumberEncrypted'> & {
      clinicId: string;
    },
  ): Promise<boolean> {
    const rows = await this.txManager.conn
      .update(clinicians)
      .set({
        clinicId: row.clinicId,
        displayName: row.displayName,
        licenseNumberEncrypted: row.licenseNumberEncrypted,
      })
      .where(
        and(
          eq(clinicians.id, row.id),
          isNull(clinicians.clinicId),
          isNull(clinicians.deletedAt),
        ),
      )
      .returning({ id: clinicians.id });
    return rows.length > 0;
  }

  /**
   * 소셜 계정 동일성 판정 (docs/specs/17) — 이메일이 아니라 provider+providerId가 기준이다.
   *
   * **leftJoin이다** (docs/specs/38): 강퇴당한 무소속 계정은 clinic이 없지만 **여전히 존재하는
   * 계정**이므로 여기서 못 찾으면 안 된다. 못 찾으면 신규 가입으로 흘러 같은 소셜 계정으로
   * 두 번째 insert가 일어나고 `uq_clinicians_oauth` 위반으로 500이 난다. clinic이 null인 결과는
   * 호출측(`socialLogin`)이 **재온보딩 티켓**으로 흡수한다.
   */
  async findByOAuthAccount(
    provider: OAuthProviderId,
    providerId: string,
  ): Promise<{ clinician: ClinicianRow; clinic: ClinicRow | null } | null> {
    const rows = await this.txManager.conn
      .select({ clinician: clinicians, clinic: clinics })
      .from(clinicians)
      .leftJoin(clinics, eq(clinicians.clinicId, clinics.id))
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

  /**
   * 세션 발급·복구가 쓰는 조회.
   *
   * **innerJoin을 유지한다** (docs/specs/38) — 무소속 계정에 세션이 발급되지 않음을 DB 조인이
   * 강제하는 안전망이다. denylist TTL이 지난 뒤 옛 access 토큰이 가드를 통과해도 여기서 null이
   * 되어 401로 수렴한다. 무소속이 「세션을 가질 수 없는 상태」라는 정의가 코드로 서는 자리다.
   */
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
