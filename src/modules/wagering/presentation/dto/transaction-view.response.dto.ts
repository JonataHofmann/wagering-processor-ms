import { MoneyDto } from '@/src/platform/http/dto/money.dto';
import { FailureCode } from '@/src/modules/wagering/error/failure-code';
import { WagerTransactionStatus } from '@/src/modules/wagering/domain/value-objects/wager-transaction-status';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Resposta de GET /wagering/transactions/:id e GET /providers/:providerId/wagering/transactions/:externalTransactionId. */
export class TransactionViewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  providerId!: string;

  @ApiProperty()
  externalTransactionId!: string;

  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ format: 'uuid' })
  playerId!: string;

  @ApiProperty()
  roundId!: string;

  @ApiProperty()
  gameId!: string;

  @ApiProperty()
  kind!: string;

  @ApiProperty({ type: MoneyDto })
  money!: MoneyDto;

  @ApiProperty({ enum: WagerTransactionStatus })
  status!: WagerTransactionStatus;

  @ApiPropertyOptional({ enum: FailureCode, nullable: true })
  failureCode!: FailureCode | null;

  @ApiPropertyOptional({ nullable: true })
  referenceExternalTransactionId!: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  referenceTransactionId!: string | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      'Omitted (null) when the wallet does not belong to the given player',
  })
  balance!: MoneyDto | null;

  @ApiProperty()
  attempts!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  processedAt!: string | null;
}
