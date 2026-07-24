import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { AesGcmUtil } from '../../../global/security/crypto/aes-gcm.util';
import { PatientRepository } from '../repository/patient.repository';
import { PatientService } from './patient.service';

/** §4.4 — 환자는 클리닉 공유 리소스: clinicId 스코프 */
export interface PatientScope {
  clinicId: string;
}

/** 스냅샷 암호문에 고정되는 페이로드 — 가이던스 컨텍스트 합성·안전 경고 규칙이 소비한다 */
export interface PatientSnapshotPayload {
  patientId: string;
  caseLabel: string;
  birthYear: number | null;
  sex: 'MALE' | 'FEMALE' | 'OTHER' | 'UNKNOWN' | null;
  heightCm: number | null;
  weightKg: number | null;
  waistCm: number | null;
  diagnoses: string[];
  medications: string[];
  allergies: string[];
  clinicalNotes: string | null;
  patientVersion: number;
  capturedAt: string;
}

export interface CaptureResult {
  snapshotId: string;
}

export interface CaptureWithProfileResult extends CaptureResult {
  payload: PatientSnapshotPayload;
}

/**
 * 가이드 생성 당시 환자 프로필을 immutable 암호화 JSON으로 고정한다 (§4.5, §9).
 * 자동 캡처 트리거는 10단계(ClinicalGuidance)가 소비한다.
 */
@Injectable()
export class PatientSnapshotService {
  constructor(
    private readonly repository: PatientRepository,
    private readonly patientService: PatientService,
    private readonly aesGcm: AesGcmUtil,
  ) {}

  async capture(scope: PatientScope, patientId: string): Promise<CaptureResult> {
    const { snapshotId } = await this.captureWithProfile(scope, patientId);
    return { snapshotId };
  }

  /**
   * 가이던스 생성용 — 스냅샷에 고정된 것과 동일한 페이로드를 함께 반환한다
   * (별도 재조회 시 스냅샷과 프로필이 어긋날 수 있어 단일 읽기로 묶는다)
   */
  async captureWithProfile(
    scope: PatientScope,
    patientId: string,
  ): Promise<CaptureWithProfileResult> {
    const row = await this.repository.findById(scope, patientId);
    if (!row) throw new ServiceException('NOT_FOUND');

    const decrypted = this.patientService.decryptFields(row);
    const payload: PatientSnapshotPayload = {
      patientId: row.id,
      caseLabel: row.caseLabel,
      birthYear: row.birthYear,
      sex: row.sex,
      heightCm: row.heightCm,
      weightKg: row.weightKg,
      waistCm: row.waistCm,
      diagnoses: decrypted.diagnoses,
      medications: decrypted.medications,
      allergies: decrypted.allergies,
      clinicalNotes: decrypted.clinicalNotes ?? null,
      patientVersion: row.version,
      capturedAt: new Date().toISOString(),
    };

    const snapshotId = ulid();
    await this.repository.insertSnapshot({
      id: snapshotId,
      patientId: row.id,
      clinicId: scope.clinicId,
      payloadEncrypted: this.aesGcm.encrypt(JSON.stringify(payload)),
    });
    return { snapshotId, payload };
  }
}
