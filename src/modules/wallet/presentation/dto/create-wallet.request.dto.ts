import { MoneyDto } from '@/src/platform/http/dto/money.dto';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsUUID, ValidateNested } from 'class-validator';

export class CreateWalletRequestDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  playerId!: string;

  @ApiProperty({ type: MoneyDto, description: 'Saldo de abertura da wallet' })
  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
