import { InboxMessageSchema } from '@/src/infrastructure/persistence/schemas/inbox-message.schema';
import { LedgerEntrySchema } from '@/src/infrastructure/persistence/schemas/ledger-entry.schema';
import { OutboxMessageSchema } from '@/src/infrastructure/persistence/schemas/outbox-message.schema';
import { WagerTransactionSchema } from '@/src/infrastructure/persistence/schemas/wager-transaction.schema';
import { WalletSchema } from '@/src/infrastructure/persistence/schemas/wallet.schema';

export const PERSISTENCE_SCHEMAS = [
  WalletSchema,
  LedgerEntrySchema,
  WagerTransactionSchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
