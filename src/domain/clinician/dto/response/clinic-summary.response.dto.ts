import { ApiProperty } from '@nestjs/swagger';

export class ClinicSummaryResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;
}
