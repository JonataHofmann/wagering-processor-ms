import { InboxMessageSchema } from './inbox-message.schema';
import { LedgerEntrySchema } from './ledger-entry.schema';
import { OutboxMessageSchema } from './outbox-message.schema';
import { WagerTransactionSchema } from './wager-transaction.schema';
import { WalletSchema } from './wallet.schema';

export const PERSISTENCE_SCHEMAS = [
  WalletSchema,
  LedgerEntrySchema,
  WagerTransactionSchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
