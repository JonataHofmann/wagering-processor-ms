import { CreateWalletUseCase } from '@/src/modules/wallet/application/use-cases/create-wallet.use-case';
import { GetWalletQuery } from '@/src/modules/wallet/application/use-cases/get-wallet.query';
import {
  LedgerPage,
  ListLedgerQuery,
} from '@/src/modules/wallet/application/use-cases/list-ledger.query';
import { WalletView } from '@/src/modules/wallet/application/use-cases/wallet-view';
import { ApiErrorResponseDto } from '@/src/platform/http/dto/api-error-response.dto';
import { CreateWalletRequestDto } from '@/src/modules/wallet/presentation/dto/create-wallet.request.dto';
import { LedgerPageDto } from '@/src/modules/wallet/presentation/dto/ledger-page.response.dto';
import { WalletReconciliationDto } from '@/src/modules/wallet/presentation/dto/wallet-reconciliation.response.dto';
import { WalletViewDto } from '@/src/modules/wallet/presentation/dto/wallet-view.response.dto';
import {
  RequestParser,
  parseUuidParam,
} from '@/src/platform/http/request-parsing';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  ReconcileWalletsUseCase,
  type WalletReconciliation,
} from '@/src/modules/wallet/application/use-cases/reconcile-wallets.use-case';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

@ApiTags('wallets')
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletQuery,
    private readonly listLedger: ListLedgerQuery,
    private readonly reconcileWallets: ReconcileWalletsUseCase,
  ) {}

  /**
   * Compara o saldo gravado com o saldo reconstruído pelo ledger. Somente leitura:
   * uma divergência volta no relatório (200), é registrada em log e métrica, e o saldo NÃO é alterado.
   */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reconcilia o saldo gravado com o saldo reconstruído pelo ledger',
    description:
      'Somente leitura: uma divergência volta no relatório (200) e é registrada em log/métrica, sem alterar o saldo.',
  })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiResponse({ status: 200, type: WalletReconciliationDto })
  @ApiResponse({
    status: 404,
    description: 'Wallet não encontrada',
    type: ApiErrorResponseDto,
  })
  async reconcile(
    @Param('walletId') walletId: string,
  ): Promise<WalletReconciliation> {
    return this.reconcileWallets.reconcile(
      parseUuidParam('walletId', walletId),
    );
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Abre uma nova wallet para um jogador' })
  @ApiHeader({
    name: 'x-correlation-id',
    required: false,
    description: 'Correlation id para rastreio; gerado quando omitido',
  })
  @ApiBody({ type: CreateWalletRequestDto })
  @ApiResponse({ status: 201, type: WalletViewDto })
  @ApiResponse({
    status: 400,
    description: 'Payload inválido',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: 'Já existe uma wallet para este jogador',
    type: ApiErrorResponseDto,
  })
  async create(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<WalletView> {
    const parser = new RequestParser(body);
    parser.requireObject('');
    const playerId = parser.uuid('playerId');
    parser.requireObject('initialBalance');
    // o formato do valor é validado pelo Money (INVALID_AMOUNT / INVALID_CURRENCY)
    const amount = parser.string('initialBalance.amount');
    const currency = parser.string('initialBalance.currency');
    parser.assertValid();

    return this.createWallet.execute({
      playerId: playerId!,
      initialBalance: { amount: amount!, currency: currency! },
      correlationId: correlationId ?? crypto.randomUUID(),
    });
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Consulta uma wallet pelo id' })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiResponse({ status: 200, type: WalletViewDto })
  @ApiResponse({
    status: 404,
    description: 'Wallet não encontrada',
    type: ApiErrorResponseDto,
  })
  async get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.getWallet.execute(parseUuidParam('walletId', walletId));
  }

  @Get(':walletId/ledger')
  @ApiOperation({ summary: 'Lista o ledger da wallet, paginado' })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { default: DEFAULT_PAGE_SIZE, maximum: MAX_PAGE_SIZE, minimum: 1 },
  })
  @ApiResponse({ status: 200, type: LedgerPageDto })
  @ApiResponse({
    status: 404,
    description: 'Wallet não encontrada',
    type: ApiErrorResponseDto,
  })
  async ledger(
    @Param('walletId') walletId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<LedgerPage> {
    const id = parseUuidParam('walletId', walletId);
    const parser = new RequestParser(query);
    const cursor = parser.string('cursor', { required: false, maxLength: 200 });
    const limit = parser.integer('limit', {
      min: 1,
      max: MAX_PAGE_SIZE,
      default: DEFAULT_PAGE_SIZE,
    });
    parser.assertValid();

    return this.listLedger.execute({ walletId: id, cursor, limit });
  }
}
