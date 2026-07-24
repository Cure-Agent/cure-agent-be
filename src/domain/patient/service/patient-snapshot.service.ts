import { Injectable } from '@nestjs/common';

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
  capture(_scope: PatientScope, _patientId: string): Promise<CaptureResult> {
    return Promise.reject(new Error('NOT_IMPLEMENTED'));
  }
}
