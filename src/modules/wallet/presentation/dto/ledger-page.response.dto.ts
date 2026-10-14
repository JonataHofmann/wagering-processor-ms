import { MoneyDto } from '@/src/platform/http/dto/money.dto';
import { LedgerDirection } from '@/src/modules/wallet/domain/value-objects/ledger-direction';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LedgerEntryViewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty()
  walletVersion!: number;

  @ApiProperty({ enum: LedgerDirection })
  direction!: LedgerDirection;

  @ApiProperty({ type: MoneyDto })
  money!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  balanceBefore!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  balanceAfter!: MoneyDto;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class LedgerPageDto {
  @ApiProperty({ type: [LedgerEntryViewDto] })
  items!: LedgerEntryViewDto[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'Cursor para a próxima página; null quando não há mais páginas',
  })
  nextCursor!: string | null;
}
