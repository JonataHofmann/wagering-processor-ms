import { GetTransactionQuery } from '@/src/modules/wagering/application/use-cases/get-transaction.query';
import { ProcessWagerTransactionUseCase } from '@/src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import {
  TransactionResult,
  TransactionView,
} from '@/src/modules/wagering/application/use-cases/transaction-view';
import { WagerTransactionStatus } from '@/src/modules/wagering/domain/value-objects/wager-transaction-status';
import { ApiErrorResponseDto } from '@/src/platform/http/dto/api-error-response.dto';
import { requireIdempotencyKey } from '@/src/platform/http/idempotency-key';
import { SubmitWagerTransactionRequestDto } from '@/src/modules/wagering/presentation/dto/submit-wager-transaction.request.dto';
import { TransactionResultDto } from '@/src/modules/wagering/presentation/dto/transaction-result.response.dto';
import { TransactionViewDto } from '@/src/modules/wagering/presentation/dto/transaction-view.response.dto';
import {
  currentLogContext,
  enrichLogContext,
} from '@/src/platform/observability/log-context';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
/** Status HTTP de uma transação aceita para processamento (nova ou replay). */
const STATUS_BY_RESULT: Readonly<Record<WagerTransactionStatus, number>> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.Rejected]: 422, // regra de negócio: não reenviar igual
  [WagerTransactionStatus.PendingReference]: 202, // aceita, aguardando a referência
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Failed]: 500, // falha permanente de infraestrutura
};

interface StatusSettable {
  status(code: number): unknown;
}

@ApiTags('wagering')
@Controller()
export class WageringController {
  constructor(
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    private readonly getTransaction: GetTransactionQuery,
  ) {}

  @Post('wagering/transactions')
  @ApiOperation({
    summary: 'Envia uma transação de aposta (BET/WIN/LOSS/REFUND/ROLLBACK)',
    description:
      'Idempotente por Idempotency-Key: reenviar a mesma chave devolve o mesmo resultado (idempotentReplay=true) sem reaplicar a operação.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Chave de idempotência da requisição (máx. 255 chars)',
  })
  @ApiBody({ type: SubmitWagerTransactionRequestDto })
  @ApiResponse({
    status: 200,
    description: 'Transação processada (PROCESSED) ou replay idempotente',
    type: TransactionResultDto,
  })
  @ApiResponse({
    status: 202,
    description: 'Transação aceita, aguardando processamento (PENDING/PENDING_REFERENCE)',
    type: TransactionResultDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Payload ou cabeçalho inválido',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: 422,
    description: 'Rejeitada por regra de negócio (ex.: saldo insuficiente)',
    type: TransactionResultDto,
  })
  @ApiResponse({
    status: 500,
    description: 'Falha permanente de infraestrutura (FAILED)',
    type: TransactionResultDto,
  })
  async submit(
    @Body() body: SubmitWagerTransactionRequestDto,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Res({ passthrough: true }) response: StatusSettable,
  ): Promise<TransactionResult> {
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyHeader);
    enrichLogContext({ walletId: body.walletId });
    const result = await this.processTransaction.execute({
      idempotencyKey,
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: { amount: body.money.amount, currency: body.money.currency },
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      correlationId: currentLogContext()?.correlationId ?? crypto.randomUUID(),
    });

    enrichLogContext({ transactionId: result.transactionId });
    response.status(STATUS_BY_RESULT[result.status]);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  @ApiOperation({ summary: 'Consulta uma transação pelo id interno' })
  @ApiParam({ name: 'transactionId', format: 'uuid' })
  @ApiResponse({ status: 200, type: TransactionViewDto })
  @ApiResponse({
    status: 404,
    description: 'Transação não encontrada',
    type: ApiErrorResponseDto,
  })
  async byId(
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
  ): Promise<TransactionView> {
    return this.getTransaction.byId(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiOperation({
    summary: 'Consulta uma transação pelo (providerId, externalTransactionId)',
  })
  @ApiParam({ name: 'providerId' })
  @ApiParam({ name: 'externalTransactionId' })
  @ApiResponse({ status: 200, type: TransactionViewDto })
  @ApiResponse({
    status: 404,
    description: 'Transação não encontrada',
    type: ApiErrorResponseDto,
  })
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.getTransaction.byExternalId(providerId, externalTransactionId);
  }
}
