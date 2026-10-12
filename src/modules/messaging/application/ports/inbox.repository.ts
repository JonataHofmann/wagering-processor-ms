import type { InboxMessage } from '../../domain/inbox-message';

export interface InboxRepository {
  tryRegister(message: InboxMessage): Promise<boolean>;
  find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export const INBOX_REPOSITORY = Symbol('InboxRepository');
