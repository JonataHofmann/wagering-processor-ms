import { ApiProperty } from '@nestjs/swagger';

/** Representação de dinheiro na API: valor decimal como string + moeda ISO-4217. */
export class MoneyDto {
  @ApiProperty({ example: '25.00', description: 'Valor decimal com 2 casas' })
  amount!: string;

  @ApiProperty({ example: 'BRL', description: 'Moeda ISO-4217' })
  currency!: string;
}
