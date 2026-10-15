import { MoneyDto } from '@/src/platform/http/dto/money.dto';
import { WagerTransactionKind } from '@/src/modules/wagering/domain/value-objects/wager-transaction-kind';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class SubmitWagerTransactionRequestDto {
  @ApiProperty({ example: 'provider-1', description: 'Provider identifier' })
  @IsString()
  @MaxLength(64)
  providerId!: string;

  @ApiProperty({ example: 'ext-tx-123' })
  @IsString()
  @MaxLength(128)
  externalTransactionId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  playerId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  walletId!: string;

  @ApiProperty({ example: 'round-1' })
  @IsString()
  @MaxLength(128)
  roundId!: string;

  @ApiProperty({ example: 'game-1' })
  @IsString()
  @MaxLength(128)
  gameId!: string;

  @ApiProperty({ enum: WagerTransactionKind })
  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @ApiProperty({ type: MoneyDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @ApiPropertyOptional({
    description:
      'Required for WIN/REFUND/ROLLBACK: points to the referenced transaction',
    example: 'ext-tx-100',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  referenceExternalTransactionId?: string;
}
