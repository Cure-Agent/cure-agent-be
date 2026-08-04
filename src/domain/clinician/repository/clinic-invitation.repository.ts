import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { TransactionManager } from '../../../global/database/transaction-manager';
import {
  ClinicInvitationRow,
  clinicInvitations,
} from '../persistence/clinic-invitation.schema';
import { clinics } from '../persistence/clinic.schema';
import { clinicians } from '../persistence/clinician.schema';

/** 초대 목록 항목 + 합류자 표시 이름 (조인 결과) */
export interface ClinicInvitationListRow {
  invitation: ClinicInvitationRow;
  acceptedByDisplayName: string | null;
}

/**
 * 커서에 실을 정렬 키 원본. Date로 받으면 pg 드라이버가 마이크로초를 버려서 같은 밀리초 안의
 * 초대가 페이지 경계에서 통째로 건너뛰어진다 — 문자열로 그대로 실어 나른다
 * (`conversation.repository.ts`의 CURSOR_LAST_MESSAGE_AT과 같은 이유).
 */
const CURSOR_CREATED_AT = sql<string>`to_char(${clinicInvitations.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export type ClinicInvitationCursorRow = ClinicInvitationListRow & { cursorCreatedAt: string };

@Injectable()
export class ClinicInvitationRepository {
  constructor(private readonly txManager: TransactionManager) {}

  async insert(
    row: Pick<
      ClinicInvitationRow,
      'id' | 'clinicId' | 'invitedByClinicianId' | 'tokenHash' | 'expiresAt'
    >,
  ): Promise<ClinicInvitationRow> {
    const rows = await this.txManager.conn.insert(clinicInvitations).values(row).returning();
    return rows[0];
  }

  /** 최신 발급순. 합류자 이름은 목록 표시용이라 left join이다(미수락 초대는 null) */
  async list(
    clinicId: string,
    filter: { after?: { createdAt: string; id: string }; limit: number },
  ): Promise<ClinicInvitationCursorRow[]> {
    const conditions = [
      eq(clinicInvitations.clinicId, clinicId),
      filter.after
        ? or(
            lt(clinicInvitations.createdAt, sql`${filter.after.createdAt}::timestamptz`),
            and(
              eq(clinicInvitations.createdAt, sql`${filter.after.createdAt}::timestamptz`),
              lt(clinicInvitations.id, filter.after.id),
            ),
          )
        : undefined,
    ].filter((c) => c !== undefined);

    const rows = await this.txManager.conn
      .select({
        invitation: clinicInvitations,
        acceptedByDisplayName: clinicians.displayName,
        cursorCreatedAt: CURSOR_CREATED_AT,
      })
      .from(clinicInvitations)
      .leftJoin(clinicians, eq(clinicInvitations.acceptedByClinicianId, clinicians.id))
      .where(and(...conditions))
      .orderBy(desc(clinicInvitations.createdAt), desc(clinicInvitations.id))
      .limit(filter.limit);

    return rows.map((row) => ({
      invitation: row.invitation,
      acceptedByDisplayName: row.acceptedByDisplayName,
      cursorCreatedAt: row.cursorCreatedAt,
    }));
  }

  /**
   * 프리뷰용 — 초대 + 한의원명. 비인증 경로가 쓰므로 **여기서 클리닉 이름만 조인**한다.
   * 서비스가 `ClinicianRepository`를 끌어오지 않게 하려는 것이다(초대 서비스의 의존은
   * 이 리포지토리와 설정 둘뿐이며, 그래야 시각 주입 유닛이 순수하게 성립한다).
   */
  async findWithClinicName(
    id: string,
  ): Promise<{ invitation: ClinicInvitationRow; clinicName: string } | null> {
    const rows = await this.txManager.conn
      .select({ invitation: clinicInvitations, clinicName: clinics.name })
      .from(clinicInvitations)
      .innerJoin(clinics, eq(clinicInvitations.clinicId, clinics.id))
      .where(eq(clinicInvitations.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<ClinicInvitationRow | null> {
    const rows = await this.txManager.conn
      .select()
      .from(clinicInvitations)
      .where(eq(clinicInvitations.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 취소 — 자기 클리닉 것만. 0행이면 미존재이거나 **타 클리닉**이며, 호출측은 둘을 구분하지 않고
   * 404로 응답한다 (§4.4 「존재 여부 자체를 숨김」).
   * 이미 취소된 초대의 시각은 덮지 않는다.
   */
  async revoke(clinicId: string, id: string, revokedAt: Date): Promise<boolean> {
    const rows = await this.txManager.conn
      .update(clinicInvitations)
      .set({ revokedAt })
      .where(
        and(
          eq(clinicInvitations.id, id),
          eq(clinicInvitations.clinicId, clinicId),
          isNull(clinicInvitations.revokedAt),
        ),
      )
      .returning({ id: clinicInvitations.id });
    return rows.length > 0;
  }

  /**
   * 1회용 소비 — `accepted_at IS NULL` 조건부 UPDATE라 동시 요청이 겹쳐도 한 번만 성립한다
   * (§34 softDelete의 「덮지 않는다」 집행과 같은 형태). 0행이면 이미 소비됐다.
   */
  async consume(id: string, acceptedAt: Date, acceptedByClinicianId: string): Promise<boolean> {
    const rows = await this.txManager.conn
      .update(clinicInvitations)
      .set({ acceptedAt, acceptedByClinicianId })
      .where(and(eq(clinicInvitations.id, id), isNull(clinicInvitations.acceptedAt)))
      .returning({ id: clinicInvitations.id });
    return rows.length > 0;
  }
}
