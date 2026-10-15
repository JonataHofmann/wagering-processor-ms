import { MoneyDto } from '@/src/platform/http/dto/money.dto';
import { FailureCode } from '@/src/modules/wagering/error/failure-code';
import { WagerTransactionStatus } from '@/src/modules/wagering/domain/value-objects/wager-transaction-status';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Resposta do POST /wagering/transactions (nova ou replay). */
export class TransactionResultDto {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ enum: WagerTransactionStatus })
  status!: WagerTransactionStatus;

  @ApiPropertyOptional({ enum: FailureCode, nullable: true })
  failureCode!: FailureCode | null;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      'Balance observed when the operation was decided; null while pending',
  })
  balance!: MoneyDto | null;

  @ApiProperty({
    description: 'true when the same Idempotency-Key had already been processed',
  })
  idempotentReplay!: boolean;
}
