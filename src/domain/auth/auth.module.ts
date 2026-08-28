import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { oauthConfig } from '../../global/config/oauth.config';
import { OAuthModule } from '../../infrastructure/oauth/oauth.module';
import { ClinicianModule } from '../clinician/clinician.module';
import { DemoPatientSeedModule } from '../patient/demo-patient-seed.module';
import { AuthSessionModule } from './auth-session.module';
import { AuthController } from './controller/auth.controller';
import { OAuthController } from './controller/oauth.controller';
import { AuthService } from './service/auth.service';
import { OAuthTicketService } from './service/oauth-ticket.service';

@Module({
  imports: [
    ConfigModule.forFeature(oauthConfig),
    ClinicianModule,
    OAuthModule,
    AuthSessionModule,
    // 클리닉 개설 직후 데모 환자 시딩 (docs/specs/41). 컨트롤러 없는 모듈이라
    // 생성되는 OpenAPI의 path 순서를 건드리지 않는다
    DemoPatientSeedModule,
  ],
  controllers: [AuthController, OAuthController],
  providers: [AuthService, OAuthTicketService],
})
export class AuthModule {}
