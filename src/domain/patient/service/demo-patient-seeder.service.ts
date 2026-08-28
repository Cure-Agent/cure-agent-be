import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ulid } from 'ulid';
import { demoSeedConfig } from '../../../global/config/demo-seed.config';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { AesGcmUtil } from '../../../global/security/crypto/aes-gcm.util';
import { patients } from '../persistence/patient.schema';
import { DEMO_PATIENTS } from './demo-patients.fixture';

/**
 * 새로 개설된 클리닉에 데모 환자를 넣는다 (`DEMO_SEED_ENABLED=true`일 때만, docs/specs/41).
 *
 * **호출자의 트랜잭션 안에서 돈다.** `TransactionManager.conn`은 CLS에 트랜잭션이 열려 있으면
 * 그것을 쓰므로 가입 트랜잭션에 그대로 합류한다 — 계정 생성이 롤백되면 환자도 함께 사라져
 * 주인 없는 행이 남지 않는다.
 *
 * **PatientRepository를 거치지 않는 이유**는 DI 배치다. 이 시더는 AuthModule이 쓰는데,
 * PatientRepository를 주입하려면 AuthModule이 PatientModule을 import해야 하고 그러면
 * PatientController가 AuthModule 하위로 끌려 들어가 **생성되는 OpenAPI의 path 순서가 바뀐다**
 * (동작은 같지만 계약 파일이 800줄 재정렬 diff로 흔들린다). 시딩은 스코프 질의가 아니라
 * 고정 픽스처의 단순 삽입이라 이 우회의 대가가 없다.
 */
@Injectable()
export class DemoPatientSeeder {
  private readonly logger = new Logger(DemoPatientSeeder.name);

  constructor(
    @Inject(demoSeedConfig.KEY)
    private readonly config: ConfigType<typeof demoSeedConfig>,
    private readonly txManager: TransactionManager,
    private readonly aesGcm: AesGcmUtil,
  ) {}

  async seed(clinicId: string): Promise<void> {
    if (!this.config.enabled) return;

    /**
     * 목록이 `ORDER BY id DESC`라(`patient.repository.ts`) **큰 id가 위로 온다.**
     * `ulid()`는 같은 밀리초 안에서 단조 증가를 보장하지 않으므로 생성 순서에 기대지 않고,
     * 뽑아둔 id를 정렬해 CASE-001에 가장 큰 값을 준다 — 화면에 001·002·003 순으로 보이게 하는
     * 유일한 방법이다.
     */
    const ids = DEMO_PATIENTS.map(() => ulid()).sort().reverse();

    await this.txManager.conn.insert(patients).values(
      DEMO_PATIENTS.map((fixture, index) => ({
        id: ids[index],
        clinicId,
        caseLabel: fixture.caseLabel,
        birthYear: fixture.birthYear,
        sex: fixture.sex,
        heightCm: fixture.heightCm,
        weightKg: fixture.weightKg,
        // 민감 필드는 일반 등록 경로와 **같은 암호문 형태**여야 한다 (§4.5) — 상세 조회가
        // 같은 복호화 코드를 타므로 여기서 형태가 어긋나면 데모 환자만 열리지 않는다
        diagnosesEncrypted: this.encryptArray(fixture.diagnoses),
        medicationsEncrypted: this.encryptArray(fixture.medications),
        allergiesEncrypted: this.encryptArray(fixture.allergies),
        clinicalNotesEncrypted: fixture.clinicalNotes
          ? this.aesGcm.encrypt(fixture.clinicalNotes)
          : null,
      })),
    );

    this.logger.log(`데모 환자 ${DEMO_PATIENTS.length}건 시딩 완료 (clinic=${clinicId})`);
  }

  private encryptArray(values: string[]): string {
    return this.aesGcm.encrypt(JSON.stringify(values));
  }
}
