import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/**
 * Representação de dinheiro na API: valor decimal como string + moeda ISO-4217.
 * Só valida o tipo (string); formato decimal e moeda são responsabilidade do
 * domínio (Money.from → INVALID_AMOUNT/INVALID_CURRENCY).
 */
export class MoneyDto {
  @ApiProperty({ example: '25.00', description: 'Decimal value with 2 places' })
  @IsString()
  amount!: string;

  @ApiProperty({ example: 'BRL', description: 'ISO-4217 currency' })
  @IsString()
  currency!: string;
}
