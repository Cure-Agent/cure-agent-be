import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import { ClinicianPrincipal } from './clinician-principal';

/** 컨트롤러에서 인증 주체 주입: `@CurrentClinician() principal: ClinicianPrincipal` */
export const CurrentClinician = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ClinicianPrincipal => {
    const request = context.switchToHttp().getRequest<Request & { clinician: ClinicianPrincipal }>();
    return request.clinician;
  },
);
