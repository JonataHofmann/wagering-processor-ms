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
      'Saldo observado quando a operação foi decidida; null enquanto pendente',
  })
  balance!: MoneyDto | null;

  @ApiProperty({
    description: 'true quando a mesma Idempotency-Key já havia sido processada',
  })
  idempotentReplay!: boolean;
}
