import { CreateWalletUseCase } from '@/src/modules/wallet/application/create-wallet.use-case';
import { GetWalletQuery } from '@/src/modules/wallet/application/get-wallet.query';
import { ListLedgerQuery, LedgerPage } from '@/src/modules/wallet/application/list-ledger.query';
import { WalletView } from '@/src/modules/wallet/application/wallet-view';
import { RequestParser, parseUuidParam } from '@/src/platform/http/request-parsing';
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


const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletQuery,
    private readonly listLedger: ListLedgerQuery,
  ) {}

  @Post()
  @HttpCode(201)
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
  async get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.getWallet.execute(parseUuidParam('walletId', walletId));
  }

  @Get(':walletId/ledger')
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
