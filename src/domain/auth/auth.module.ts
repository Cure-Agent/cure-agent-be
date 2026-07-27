import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { oauthConfig } from '../../global/config/oauth.config';
import { OAuthModule } from '../../infrastructure/oauth/oauth.module';
import { ClinicianModule } from '../clinician/clinician.module';
import { AuthController } from './controller/auth.controller';
import { OAuthController } from './controller/oauth.controller';
import { AuthSessionRepository } from './repository/auth-session.repository';
import { AuthService } from './service/auth.service';
import { OAuthTicketService } from './service/oauth-ticket.service';

@Module({
  imports: [ConfigModule.forFeature(oauthConfig), ClinicianModule, OAuthModule],
  controllers: [AuthController, OAuthController],
  providers: [AuthService, AuthSessionRepository, OAuthTicketService],
})
export class AuthModule {}
