import { ApiProperty } from '@nestjs/swagger';
import { GuidelineJobResponseDto } from './guideline-job.response.dto';
import { PipelineRunResponseDto } from './pipeline-run.response.dto';

/**
 * 잡 1건 + 문서별 실행 전체 (docs/specs/22).
 *
 * 실행을 서브리소스로 쪼개지 않고 중첩한다 — 전건이어도 86행이라 페이지네이션이 필요할 만큼
 * 커지지 않는다(§21이 버전 이력을 중첩한 것과 같은 판단).
 */
export class GuidelineJobDetailResponseDto extends GuidelineJobResponseDto {
  @ApiProperty({
    type: [PipelineRunResponseDto],
    description: '`order` 오름차순 — 뒤이어 오는 run.stage를 그대로 이어붙일 수 있어야 한다',
  })
  runs!: PipelineRunResponseDto[];
}
