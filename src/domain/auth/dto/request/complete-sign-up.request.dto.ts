import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsBoolean, IsString, Length } from 'class-validator';

/**
 * 온보딩 완료 요청 (docs/specs/17).
 * 이메일·provider·providerId는 서버가 티켓에서 꺼내므로 바디에 받지 않는다 — 위조 방지.
 */
export class CompleteSignUpRequestDto {
  @ApiProperty({ description: '소셜 콜백이 발급한 1회용 티켓' })
  @IsString()
  @Length(1, 200)
  ticket!: string;

  @ApiProperty({ example: '김의사', description: '기본값은 소셜 프로필 이름' })
  @IsString()
  @Length(1, 50)
  displayName!: string;

  @ApiProperty({ example: '서울한의원' })
  @IsString()
  @Length(1, 100)
  clinicName!: string;

  @ApiProperty({ description: '면허번호 — 저장 시 암호화된다' })
  @IsString()
  @Length(1, 50)
  licenseNumber!: string;

  @ApiProperty({ description: 'true 필수' })
  @IsBoolean()
  @Equals(true)
  termsAccepted!: boolean;
}
