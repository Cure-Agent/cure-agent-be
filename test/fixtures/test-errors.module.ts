import { Body, Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { IsEmail } from 'class-validator';
import { ServiceException } from '../../src/global/common/exception/service.exception';

class ValidateRequestDto {
  @IsEmail()
  email!: string;
}

/** e2e 전용: 예외 필터·검증 파이프 동작 검증용 라우트. 프로덕션 모듈에 포함되지 않는다. */
@Controller('test-errors')
class TestErrorsController {
  @Get('conflict')
  conflict(): never {
    throw new ServiceException('PATIENT_VERSION_CONFLICT', { currentVersion: 4 });
  }

  @Get('boom')
  boom(): never {
    throw new Error('boom');
  }

  @Post('validate')
  @HttpCode(200)
  validate(@Body() dto: ValidateRequestDto): ValidateRequestDto {
    return dto;
  }
}

@Module({ controllers: [TestErrorsController] })
export class TestErrorsModule {}
