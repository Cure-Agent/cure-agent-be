import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class TransferClinicOwnerRequestDto {
  @ApiProperty({
    description: '새 개설자가 될 구성원 id — 같은 클리닉의 살아 있는 구성원이어야 한다',
  })
  @IsString()
  @Length(1, 40)
  toClinicianId!: string;
}
