import { ApiProperty } from '@nestjs/swagger';
import { OAUTH_PROVIDER_IDS, OAuthProviderId } from '../../../../infrastructure/oauth/oauth-provider.port';

/** FE가 로그인 버튼을 그릴 때 쓰는 활성 제공자 목록 (docs/specs/17). */
export class OAuthProvidersResponseDto {
  @ApiProperty({
    isArray: true,
    enum: OAUTH_PROVIDER_IDS,
    description: 'client id가 설정되어 실제로 사용 가능한 제공자만 내려온다',
  })
  providers!: OAuthProviderId[];
}
