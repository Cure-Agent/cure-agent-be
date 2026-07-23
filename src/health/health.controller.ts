import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ApiEnvelopeResponse } from '../global/common/response/api-envelope.decorator';
import { Public } from '../global/security/public.decorator';

export class HealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: string;
}

@ApiTags('Health')
@Public()
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: '서버 상태 확인' })
  @ApiEnvelopeResponse(HealthResponseDto)
  check(): HealthResponseDto {
    return { status: 'ok' };
  }
}
