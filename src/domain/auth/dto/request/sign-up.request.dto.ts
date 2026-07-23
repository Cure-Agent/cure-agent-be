import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsBoolean, IsEmail, IsString, Length, MinLength } from 'class-validator';

export class SignUpRequestDto {
  @ApiProperty({ example: 'doctor@clinic.kr' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10)
  password!: string;

  @ApiProperty({ example: '김의사' })
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
