import { MoneyDto } from '@/src/platform/http/dto/money.dto';
import { ApiProperty } from '@nestjs/swagger';

export class WalletViewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  playerId!: string;

  @ApiProperty({ type: MoneyDto })
  balance!: MoneyDto;

  @ApiProperty({ description: 'Increments on every ledger entry' })
  version!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
