import { GetTransactionQuery } from '@/src/modules/wagering/application/use-cases/get-transaction.query';
import { ProcessWagerTransactionUseCase } from '@/src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import {
  TransactionResult,
  TransactionView,
} from '@/src/modules/wagering/application/use-cases/transaction-view';
import { WagerTransactionKind } from '@/src/modules/wagering/domain/value-objects/wager-transaction-kind';
import { WagerTransactionStatus } from '@/src/modules/wagering/domain/value-objects/wager-transaction-status';
import {
  RequestParser,
  parseUuidParam,
} from '@/src/platform/http/request-parsing';
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
  Post,
  Res,
} from '@nestjs/common';
/** Status HTTP de uma transação aceita para processamento (nova ou replay). */
const STATUS_BY_RESULT: Readonly<Record<WagerTransactionStatus, number>> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.Rejected]: 422, // regra de negócio: não reenviar igual
  [WagerTransactionStatus.PendingReference]: 202, // aceita, aguardando a referência
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Failed]: 500, // falha permanente de infraestrutura
};

const KINDS = Object.values(WagerTransactionKind);

interface StatusSettable {
  status(code: number): unknown;
}

@Controller()
export class WageringController {
  constructor(
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    private readonly getTransaction: GetTransactionQuery,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: StatusSettable,
  ): Promise<TransactionResult> {
    const headers = new RequestParser({ 'Idempotency-Key': idempotencyKey });
    const key = headers.string('Idempotency-Key', { maxLength: 255 });
    headers.assertValid();

    const parser = new RequestParser(body);
    parser.requireObject('');
    const providerId = parser.string('providerId', { maxLength: 64 });
    const externalTransactionId = parser.string('externalTransactionId', {
      maxLength: 128,
    });
    const playerId = parser.uuid('playerId');
    const walletId = parser.uuid('walletId');
    const roundId = parser.string('roundId', { maxLength: 128 });
    const gameId = parser.string('gameId', { maxLength: 128 });
    const kind = parser.oneOf('kind', KINDS);
    parser.requireObject('money');
    const amount = parser.string('money.amount');
    const currency = parser.string('money.currency');
    const referenceExternalTransactionId = parser.string(
      'referenceExternalTransactionId',
      {
        required: false,
        maxLength: 128,
      },
    );
    parser.assertValid();
    enrichLogContext({ walletId: walletId! });
    const result = await this.processTransaction.execute({
      idempotencyKey: key!,
      providerId: providerId!,
      externalTransactionId: externalTransactionId!,
      playerId: playerId!,
      walletId: walletId!,
      roundId: roundId!,
      gameId: gameId!,
      kind: kind!,
      money: { amount: amount!, currency: currency! },
      referenceExternalTransactionId,
      correlationId: currentLogContext()?.correlationId ?? crypto.randomUUID(),
    });

    enrichLogContext({ transactionId: result.transactionId });
    response.status(STATUS_BY_RESULT[result.status]);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async byId(
    @Param('transactionId') transactionId: string,
  ): Promise<TransactionView> {
    return this.getTransaction.byId(
      parseUuidParam('transactionId', transactionId),
    );
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.getTransaction.byExternalId(providerId, externalTransactionId);
  }
}
