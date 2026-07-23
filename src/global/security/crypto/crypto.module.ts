import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { cryptoConfig } from './crypto.config';
import { AesGcmUtil } from './aes-gcm.util';
import { HmacIndexUtil } from './hmac-index.util';

@Global()
@Module({
  imports: [ConfigModule.forFeature(cryptoConfig)],
  providers: [AesGcmUtil, HmacIndexUtil],
  exports: [AesGcmUtil, HmacIndexUtil],
})
export class CryptoModule {}
