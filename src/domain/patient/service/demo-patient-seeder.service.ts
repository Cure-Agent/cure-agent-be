import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { demoSeedConfig } from '../../../global/config/demo-seed.config';
import { TransactionManager } from '../../../global/database/transaction-manager';
import { AesGcmUtil } from '../../../global/security/crypto/aes-gcm.util';

/**
 * 새로 개설된 클리닉에 데모 환자를 넣는다 (docs/specs/41). **로직은 구현에서.**
 *
 * 호출자의 트랜잭션 안에서 돌아야 한다 — `TransactionManager.conn`이 CLS에 열린 트랜잭션을
 * 쓰므로 가입 tx에 합류하고, 가입이 롤백되면 환자도 함께 사라진다.
 */
@Injectable()
export class DemoPatientSeeder {
  constructor(
    @Inject(demoSeedConfig.KEY)
    private readonly config: ConfigType<typeof demoSeedConfig>,
    private readonly txManager: TransactionManager,
    private readonly aesGcm: AesGcmUtil,
  ) {}

  async seed(_clinicId: string): Promise<void> {
    // 구현에서 채운다
  }
}
