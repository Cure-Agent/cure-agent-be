import { ApiProperty } from '@nestjs/swagger';
import { AdminGuidelineVersionResponseDto } from './admin-guideline-version.response.dto';

/**
 * 관리 목록 1행 (docs/specs/21).
 * 버전을 서브리소스로 분리하지 않고 중첩한다 — 지침당 판본 1~3개 + revision 몇 개라
 * 86건 전부여도 200행 남짓이고 페이지네이션이 필요할 만큼 커지지 않는다.
 */
export class AdminGuidelineResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: '요통 한의표준임상진료지침' })
  title!: string;

  @ApiProperty({ example: '한국한의약진흥원' })
  publisher!: string;

  @ApiProperty({
    type: [AdminGuidelineVersionResponseDto],
    description: '판본 내림차순 → 같은 판본 안에서 revision 내림차순',
  })
  versions!: AdminGuidelineVersionResponseDto[];
}
