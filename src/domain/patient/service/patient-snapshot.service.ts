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

export interface CaptureResult {
  snapshotId: string;
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
    const row = await this.repository.findById(scope, patientId);
    if (!row) throw new ServiceException('NOT_FOUND');

    const decrypted = this.patientService.decryptFields(row);
    const payload = {
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
    return { snapshotId };
  }
}
