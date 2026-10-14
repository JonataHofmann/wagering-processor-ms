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
  test('nasce não processada', () => {
    const message = InboxMessage.receive(props());
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test.each([
    ['messageId vazio', { messageId: '' }],
    ['messageId só com espaços', { messageId: '   ' }],
    ['messageId longo demais', { messageId: 'x'.repeat(129) }],
    ['consumerName vazio', { consumerName: '' }],
    ['hash fora do formato', { payloadHash: 'nao-e-hash' }],
    ['hash em maiúsculas', { payloadHash: HASH.toUpperCase() }],
  ])('%s é bug (o consumer valida antes)', (_, overrides) => {
    expect(() => InboxMessage.receive(props(overrides))).toThrow(
      InvariantViolationError,
    );
  });
});

describe('markProcessed', () => {
  test('registra o momento do processamento', () => {
    const message = InboxMessage.receive(props());
    message.markProcessed(T0);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(T0);
  });

  test('processar duas vezes é bug', () => {
    const message = InboxMessage.receive(props());
    message.markProcessed(T0);
    expect(() => message.markProcessed(T0)).toThrow(InvariantViolationError);
  });
});

describe('matchesPayload', () => {
  test('mesmo hash é a mesma mensagem', () => {
    expect(InboxMessage.receive(props()).matchesPayload(HASH)).toBe(true);
  });

  test('mesmo messageId com conteúdo diferente é anomalia', () => {
    expect(InboxMessage.receive(props()).matchesPayload('b'.repeat(64))).toBe(
      false,
    );
  });
});

describe('rehydrate', () => {
  test('restaura uma mensagem já processada', () => {
    const message = InboxMessage.rehydrate({ ...props(), processedAt: T0 });
    expect(message.isProcessed()).toBe(true);
  });
});
