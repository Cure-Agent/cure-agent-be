import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  PayloadTooLargeException,
  Post,
} from '@nestjs/common';
import { IsEmail } from 'class-validator';
import { ServiceException } from '../../src/global/common/exception/service.exception';
import { Public } from '../../src/global/security/public.decorator';

class ValidateRequestDto {
  @IsEmail()
  email!: string;
}

/** e2e 전용: 예외 필터·검증 파이프 동작 검증용 라우트. 프로덕션 모듈에 포함되지 않는다. */
@Public()
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

  /** 레지스트리 매핑(STATUS_TO_CODE)에 없는 4xx HttpException */
  @Get('payload-too-large')
  payloadTooLarge(): never {
    throw new PayloadTooLargeException();
  }

  /** 운영의 압축 해제 실패 모양 — http-errors가 Node 코어(zlib) Error에 status·expose를 덧씌운 일반 Error */
  @Get('http-error-4xx')
  httpError4xx(): never {
    throw Object.assign(new Error('Decompression failed'), {
      status: 400,
      statusCode: 400,
      expose: true,
    });
  }

  /** 상류 응답 status를 실은 예외 모양 — expose가 없어 http-errors가 아니다(우리 장애) */
  @Get('upstream-status')
  upstreamStatus(): never {
    throw Object.assign(new Error('upstream rejected'), { status: 401, statusCode: 401 });
  }

  /** http-errors 모양의 5xx — body-parser `stream.not.readable` 같은 서버 쪽 결함 */
  @Get('http-error-5xx')
  httpError5xx(): never {
    throw Object.assign(new Error('stream is not readable'), {
      status: 500,
      statusCode: 500,
      expose: false,
    });
  }

  @Post('validate')
  @HttpCode(200)
  validate(@Body() dto: ValidateRequestDto): ValidateRequestDto {
    return dto;
  }
}

@Module({ controllers: [TestErrorsController] })
export class TestErrorsModule {}
