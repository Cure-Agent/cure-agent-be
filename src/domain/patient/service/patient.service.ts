import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { decodeCursor, encodeCursor } from '../../../global/common/cursor/cursor.util';
import { ServiceException } from '../../../global/common/exception/service.exception';
import { PageResult } from '../../../global/common/response/page-result';
import { AesGcmUtil } from '../../../global/security/crypto/aes-gcm.util';
import { CreatePatientRequestDto } from '../dto/request/create-patient.request.dto';
import { ListPatientsQueryDto } from '../dto/request/list-patients.query.dto';
import { UpdatePatientRequestDto } from '../dto/request/update-patient.request.dto';
import { PatientDetailResponseDto } from '../dto/response/patient-detail.response.dto';
import { PatientSummaryResponseDto } from '../dto/response/patient-summary.response.dto';
import {
  DecryptedPatientFields,
  toPatientDetail,
  toPatientSummary,
} from '../mapper/patient.mapper';
import { PatientRow } from '../persistence/patient.schema';
import { PatientRepository } from '../repository/patient.repository';
import { PatientScope } from './patient-snapshot.service';

const DEFAULT_SIZE = 20;

interface IdCursor extends Record<string, unknown> {
  id: string;
}

@Injectable()
export class PatientService {
  constructor(
    private readonly repository: PatientRepository,
    private readonly aesGcm: AesGcmUtil,
  ) {}

  async create(
    scope: PatientScope,
    dto: CreatePatientRequestDto,
  ): Promise<PatientDetailResponseDto> {
    const id = ulid();
    await this.repository.insert({
      id,
      clinicId: scope.clinicId,
      caseLabel: dto.caseLabel,
      birthYear: dto.birthYear ?? null,
      sex: dto.sex ?? null,
      heightCm: dto.heightCm ?? null,
      weightKg: dto.weightKg ?? null,
      waistCm: dto.waistCm ?? null,
      diagnosesEncrypted: this.encryptArray(dto.diagnoses),
      medicationsEncrypted: this.encryptArray(dto.medications),
      allergiesEncrypted: this.encryptArray(dto.allergies),
      clinicalNotesEncrypted:
        dto.clinicalNotes !== undefined ? this.aesGcm.encrypt(dto.clinicalNotes) : null,
    });

    return this.detail(scope, id);
  }

  async list(
    scope: PatientScope,
    query: ListPatientsQueryDto,
  ): Promise<PageResult<PatientSummaryResponseDto>> {
    const size = query.size ?? DEFAULT_SIZE;
    const afterId = query.cursor ? decodeCursor<IdCursor>(query.cursor).id : undefined;

    const rows = await this.repository.list(scope, {
      query: query.query,
      status: query.status,
      afterId,
      limit: size + 1,
    });
    const hasNext = rows.length > size;
    const page = rows.slice(0, size);

    return PageResult.of(page.map(toPatientSummary), {
      size, // 요청 size 에코 (§10.4 — spec 09 동결 계약)
      hasNext,
      nextCursor: hasNext ? encodeCursor({ id: page[page.length - 1].id }) : null,
    });
  }

  async detail(scope: PatientScope, patientId: string): Promise<PatientDetailResponseDto> {
    const row = await this.repository.findById(scope, patientId);
    if (!row) throw new ServiceException('NOT_FOUND');
    return toPatientDetail(row, this.decryptFields(row));
  }

  async update(
    scope: PatientScope,
    patientId: string,
    dto: UpdatePatientRequestDto,
  ): Promise<PatientDetailResponseDto> {
    const row = await this.repository.findById(scope, patientId);
    if (!row) throw new ServiceException('NOT_FOUND');
    if (row.status === 'ARCHIVED') throw new ServiceException('PATIENT_ARCHIVED');
    if (dto.version !== row.version) {
      throw new ServiceException('PATIENT_VERSION_CONFLICT', { currentVersion: row.version });
    }

    const updated = await this.repository.updateWithVersion(scope, patientId, row.version, {
      ...(dto.caseLabel !== undefined ? { caseLabel: dto.caseLabel } : {}),
      ...(dto.birthYear !== undefined ? { birthYear: dto.birthYear } : {}),
      ...(dto.sex !== undefined ? { sex: dto.sex } : {}),
      ...(dto.heightCm !== undefined ? { heightCm: dto.heightCm } : {}),
      ...(dto.weightKg !== undefined ? { weightKg: dto.weightKg } : {}),
      ...(dto.waistCm !== undefined ? { waistCm: dto.waistCm } : {}),
      ...(dto.diagnoses !== undefined
        ? { diagnosesEncrypted: this.encryptArray(dto.diagnoses) }
        : {}),
      ...(dto.medications !== undefined
        ? { medicationsEncrypted: this.encryptArray(dto.medications) }
        : {}),
      ...(dto.allergies !== undefined
        ? { allergiesEncrypted: this.encryptArray(dto.allergies) }
        : {}),
      ...(dto.clinicalNotes !== undefined
        ? { clinicalNotesEncrypted: this.aesGcm.encrypt(dto.clinicalNotes) }
        : {}),
    });

    // findById 이후 다른 트랜잭션이 먼저 갱신한 경합 — 최신 버전으로 409
    if (!updated) {
      const current = await this.repository.findById(scope, patientId);
      throw new ServiceException('PATIENT_VERSION_CONFLICT', {
        currentVersion: current?.version ?? row.version,
      });
    }

    return toPatientDetail(updated, this.decryptFields(updated));
  }

  async archive(scope: PatientScope, patientId: string): Promise<null> {
    const row = await this.repository.findById(scope, patientId);
    if (!row) throw new ServiceException('NOT_FOUND');
    await this.repository.updateStatus(scope, patientId, 'ARCHIVED');
    return null;
  }

  async unarchive(scope: PatientScope, patientId: string): Promise<null> {
    const row = await this.repository.findById(scope, patientId);
    if (!row) throw new ServiceException('NOT_FOUND');
    await this.repository.updateStatus(scope, patientId, 'ACTIVE');
    return null;
  }

  /** 스냅샷·가이던스(10단계)가 재사용하는 복호화 접근자 */
  decryptFields(row: PatientRow): DecryptedPatientFields {
    return {
      diagnoses: JSON.parse(this.aesGcm.decrypt(row.diagnosesEncrypted)) as string[],
      medications: JSON.parse(this.aesGcm.decrypt(row.medicationsEncrypted)) as string[],
      allergies: JSON.parse(this.aesGcm.decrypt(row.allergiesEncrypted)) as string[],
      clinicalNotes: row.clinicalNotesEncrypted
        ? this.aesGcm.decrypt(row.clinicalNotesEncrypted)
        : undefined,
    };
  }

  private encryptArray(values: string[]): string {
    return this.aesGcm.encrypt(JSON.stringify(values));
  }
}
