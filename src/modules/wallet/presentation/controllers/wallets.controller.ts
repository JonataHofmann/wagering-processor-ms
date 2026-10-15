import { CreateWalletUseCase } from '@/src/modules/wallet/application/use-cases/create-wallet.use-case';
import { GetWalletQuery } from '@/src/modules/wallet/application/use-cases/get-wallet.query';
import {
  LedgerPage,
  ListLedgerQuery,
} from '@/src/modules/wallet/application/use-cases/list-ledger.query';
import { WalletView } from '@/src/modules/wallet/application/use-cases/wallet-view';
import { ApiErrorResponseDto } from '@/src/platform/http/dto/api-error-response.dto';
import { CreateWalletRequestDto } from '@/src/modules/wallet/presentation/dto/create-wallet.request.dto';
import {
  DEFAULT_PAGE_SIZE,
  ListLedgerQueryDto,
  MAX_PAGE_SIZE,
} from '@/src/modules/wallet/presentation/dto/list-ledger.query.dto';
import { LedgerPageDto } from '@/src/modules/wallet/presentation/dto/ledger-page.response.dto';
import { WalletReconciliationDto } from '@/src/modules/wallet/presentation/dto/wallet-reconciliation.response.dto';
import { WalletViewDto } from '@/src/modules/wallet/presentation/dto/wallet-view.response.dto';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
    summary: 'Reconciles the stored balance with the balance rebuilt from the ledger',
    description:
      'Read-only: a divergence comes back in the report (200) and is recorded in logs/metrics, without changing the balance.',
  })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiResponse({ status: 200, type: WalletReconciliationDto })
  @ApiResponse({
    status: 404,
    description: 'Wallet not found',
    type: ApiErrorResponseDto,
  })
  async reconcile(
    @Param('walletId', ParseUUIDPipe) walletId: string,
  ): Promise<WalletReconciliation> {
    return this.reconcileWallets.reconcile(walletId);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Opens a new wallet for a player' })
  @ApiHeader({
    name: 'x-correlation-id',
    required: false,
    description: 'Correlation id for tracing; generated when omitted',
  })
  @ApiBody({ type: CreateWalletRequestDto })
  @ApiResponse({ status: 201, type: WalletViewDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid payload',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: 'A wallet already exists for this player',
    type: ApiErrorResponseDto,
  })
  async create(
    @Body() body: CreateWalletRequestDto,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<WalletView> {
    return this.createWallet.execute({
      playerId: body.playerId,
      initialBalance: {
        amount: body.initialBalance.amount,
        currency: body.initialBalance.currency,
      },
      correlationId: correlationId ?? crypto.randomUUID(),
    });
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Looks up a wallet by id' })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiResponse({ status: 200, type: WalletViewDto })
  @ApiResponse({
    status: 404,
    description: 'Wallet not found',
    type: ApiErrorResponseDto,
  })
  async get(
    @Param('walletId', ParseUUIDPipe) walletId: string,
  ): Promise<WalletView> {
    return this.getWallet.execute(walletId);
  }

  @Get(':walletId/ledger')
  @ApiOperation({ summary: 'Lists the wallet ledger, paginated' })
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
    description: 'Wallet not found',
    type: ApiErrorResponseDto,
  })
  async ledger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query() query: ListLedgerQueryDto,
  ): Promise<LedgerPage> {
    return this.listLedger.execute({
      walletId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }
}
