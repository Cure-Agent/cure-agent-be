import { Module } from '@nestjs/common';
import { ClinicianModule } from '../clinician/clinician.module';
import { AuthController } from './controller/auth.controller';
import { AuthSessionRepository } from './repository/auth-session.repository';
import { AuthService } from './service/auth.service';

@Module({
  imports: [ClinicianModule],
  controllers: [AuthController],
  providers: [AuthService, AuthSessionRepository],
})
export class AuthModule {}
