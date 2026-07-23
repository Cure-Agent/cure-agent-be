import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class EmailAvailabilityQueryDto {
  @ApiProperty({ example: 'doctor@clinic.kr' })
  @IsEmail()
  email!: string;
}
