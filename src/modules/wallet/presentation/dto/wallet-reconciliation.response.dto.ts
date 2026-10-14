import { MoneyDto } from '@/src/platform/http/dto/money.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DiscrepancyDto {
  @ApiProperty({
    enum: [
      'BALANCE_MISMATCH',
      'LAST_ENTRY_MISMATCH',
      'VERSION_MISMATCH',
      'LEDGER_CHAIN_BROKEN',
      'LEDGER_VERSION_GAP',
    ],
  })
  code!: string;

  @ApiProperty()
  detail!: string;
}

/** Relatório somente-leitura: compara o saldo gravado com o reconstruído pelo ledger. */
export class WalletReconciliationDto {
  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ description: 'true quando não há divergências' })
  consistent!: boolean;

  @ApiProperty({ type: MoneyDto })
  storedBalance!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  ledgerBalance!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  difference!: MoneyDto;

  @ApiProperty()
  walletVersion!: number;

  @ApiProperty()
  ledgerEntries!: number;

  @ApiPropertyOptional({ nullable: true })
  lastLedgerVersion!: number | null;

  @ApiProperty({ type: [DiscrepancyDto] })
  discrepancies!: DiscrepancyDto[];

  @ApiProperty({ format: 'date-time' })
  checkedAt!: string;
}
