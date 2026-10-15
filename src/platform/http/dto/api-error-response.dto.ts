import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiErrorDetailDto {
  @ApiProperty({ example: 'VALIDATION_ERROR' })
  code!: string;

  @ApiProperty({ example: 'invalid request' })
  message!: string;

  @ApiPropertyOptional({
    description: 'Additional error details (e.g. validation violations)',
  })
  details?: unknown;
}

/** Formato de resposta de erro de TODOS os endpoints (ver ErrorMappingFilter). */
export class ApiErrorResponseDto {
  @ApiProperty({ type: ApiErrorDetailDto })
  error!: ApiErrorDetailDto;
}
