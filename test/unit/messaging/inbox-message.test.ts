import {
  InboxMessage,
  type ReceiveInboxProps,
} from '@/src/modules/messaging/domain/entities/inbox-message';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';
import { describe, expect, test } from 'bun:test';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const HASH = 'a'.repeat(64);

function props(overrides: Partial<ReceiveInboxProps> = {}): ReceiveInboxProps {
  return {
    messageId: 'msg-123',
    consumerName: 'wager-transactions',
    payloadHash: HASH,
    receivedAt: T0,
    ...overrides,
  };
}

describe('receive', () => {
  test('starts unprocessed', () => {
    const message = InboxMessage.receive(props());
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test.each([
    ['empty messageId', { messageId: '' }],
    ['messageId with only spaces', { messageId: '   ' }],
    ['messageId too long', { messageId: 'x'.repeat(129) }],
    ['empty consumerName', { consumerName: '' }],
    ['malformed hash', { payloadHash: 'nao-e-hash' }],
    ['uppercase hash', { payloadHash: HASH.toUpperCase() }],
  ])('%s is a bug (the consumer validates beforehand)', (_, overrides) => {
    expect(() => InboxMessage.receive(props(overrides))).toThrow(
      InvariantViolationError,
    );
  });
});

describe('markProcessed', () => {
  test('records the moment of processing', () => {
    const message = InboxMessage.receive(props());
    message.markProcessed(T0);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(T0);
  });

  test('processing twice is a bug', () => {
    const message = InboxMessage.receive(props());
    message.markProcessed(T0);
    expect(() => message.markProcessed(T0)).toThrow(InvariantViolationError);
  });
});

describe('matchesPayload', () => {
  test('same hash is the same message', () => {
    expect(InboxMessage.receive(props()).matchesPayload(HASH)).toBe(true);
  });

  test('same messageId with different content is an anomaly', () => {
    expect(InboxMessage.receive(props()).matchesPayload('b'.repeat(64))).toBe(
      false,
    );
  });
});

describe('rehydrate', () => {
  test('restores an already processed message', () => {
    const message = InboxMessage.rehydrate({ ...props(), processedAt: T0 });
    expect(message.isProcessed()).toBe(true);
  });
});
