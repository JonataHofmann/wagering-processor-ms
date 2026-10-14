import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/**
 * Representação de dinheiro na API: valor decimal como string + moeda ISO-4217.
 * Só valida o tipo (string); formato decimal e moeda são responsabilidade do
 * domínio (Money.from → INVALID_AMOUNT/INVALID_CURRENCY).
 */
export class MoneyDto {
  @ApiProperty({ example: '25.00', description: 'Valor decimal com 2 casas' })
  @IsString()
  amount!: string;

  @ApiProperty({ example: 'BRL', description: 'Moeda ISO-4217' })
  @IsString()
  currency!: string;
}
