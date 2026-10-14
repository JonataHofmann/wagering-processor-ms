import { MoneyDto } from '@/src/platform/http/dto/money.dto';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWalletRequestDto {
  @ApiProperty({ format: 'uuid' })
  playerId!: string;

  @ApiProperty({ type: MoneyDto, description: 'Saldo de abertura da wallet' })
  initialBalance!: MoneyDto;
}
