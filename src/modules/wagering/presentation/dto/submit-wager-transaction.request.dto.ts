import { MoneyDto } from '@/src/platform/http/dto/money.dto';
import { WagerTransactionKind } from '@/src/modules/wagering/domain/value-objects/wager-transaction-kind';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitWagerTransactionRequestDto {
  @ApiProperty({ example: 'provider-1', description: 'Identificador do provedor' })
  providerId!: string;

  @ApiProperty({ example: 'ext-tx-123' })
  externalTransactionId!: string;

  @ApiProperty({ format: 'uuid' })
  playerId!: string;

  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ example: 'round-1' })
  roundId!: string;

  @ApiProperty({ example: 'game-1' })
  gameId!: string;

  @ApiProperty({ enum: WagerTransactionKind })
  kind!: WagerTransactionKind;

  @ApiProperty({ type: MoneyDto })
  money!: MoneyDto;

  @ApiPropertyOptional({
    description:
      'Obrigatório para WIN/REFUND/ROLLBACK: aponta para a transação referenciada',
    example: 'ext-tx-100',
  })
  referenceExternalTransactionId?: string;
}
