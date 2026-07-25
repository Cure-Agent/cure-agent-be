import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ApiEnvelopeResponse } from '../global/common/response/api-envelope.decorator';
import { Public } from '../global/security/public.decorator';
import { DependencyStatus, ReadinessService } from './readiness.service';

export class HealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: string;
}

export class ReadinessDependenciesDto {
  @ApiProperty({ example: 'up', enum: ['up', 'down'] })
  database!: DependencyStatus;

  @ApiProperty({ example: 'up', enum: ['up', 'down'] })
  redis!: DependencyStatus;
}

export class ReadinessResponseDto {
  @ApiProperty({ example: 'ready' })
  status!: string;

  @ApiProperty({ type: ReadinessDependenciesDto })
  dependencies!: ReadinessDependenciesDto;
}

@ApiTags('Health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly readinessService: ReadinessService) {}

  /** liveness — 프로세스 생존만 본다. 의존성 장애로 재시작되면 안 되므로 여기서 DB·Redis를 보지 않는다 */
  @Get()
  @ApiOperation({ summary: '서버 상태 확인 (liveness)' })
  @ApiEnvelopeResponse(HealthResponseDto)
  check(): HealthResponseDto {
    return { status: 'ok' };
  }

  /** readiness — 트래픽을 받아도 되는지. 의존성이 끊기면 503 SERVICE_NOT_READY (docs/specs/16) */
  @Get('ready')
  @ApiOperation({ summary: '트래픽 수용 준비 확인 (readiness)' })
  @ApiEnvelopeResponse(ReadinessResponseDto)
  ready(): Promise<ReadinessResponseDto> {
    return this.readinessService.check();
  }
}
