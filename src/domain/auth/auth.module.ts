import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { oauthConfig } from '../../global/config/oauth.config';
import { OAuthModule } from '../../infrastructure/oauth/oauth.module';
import { ClinicianModule } from '../clinician/clinician.module';
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
  ],
  controllers: [AuthController, OAuthController],
  providers: [AuthService, OAuthTicketService],
})
export class AuthModule {}
