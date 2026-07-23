import { ApiProperty } from '@nestjs/swagger';

export class EmailAvailabilityResponseDto {
  @ApiProperty()
  available!: boolean;
}
