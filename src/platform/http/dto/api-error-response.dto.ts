import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiErrorDetailDto {
  @ApiProperty({ example: 'VALIDATION_ERROR' })
  code!: string;

  @ApiProperty({ example: 'invalid request' })
  message!: string;

  @ApiPropertyOptional({
    description: 'Detalhes adicionais do erro (ex.: violações de validação)',
  })
  details?: unknown;
}

/** Formato de resposta de erro de TODOS os endpoints (ver ErrorMappingFilter). */
export class ApiErrorResponseDto {
  @ApiProperty({ type: ApiErrorDetailDto })
  error!: ApiErrorDetailDto;
}
