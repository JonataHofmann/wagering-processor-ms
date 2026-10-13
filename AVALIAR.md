- src/modules/wallet/domain/wallet.ts
- src/modules/wagering/domain/wager-transaction.ts
- src/platform/http/error-mapping.filter.ts
- src/modules/wagering/infrastructure/http/wagering.controller.ts

muitas interfaces dentro do arquivo

src/modules/wagering/application/process-wager-transaction.use-case.ts
AQUI TEM UM IMPORT QUE PARECE ESTAR ERRADO
import { WalletBalanceChanged } from '@/src/modules/wagering/domain/events/wallet-balance-changed.event'; //REVISAR
