import {
  canonicalHash,
  canonicalize,
  sha256Hex,
} from '@/src/shared/util/canonical-hash';
import { describe, expect, test } from 'bun:test';

import { CanonicalizationError } from '@/src/shared/error/canonicalization-error';
import { Money } from '@/src/shared/domain/money';

const BET_PAYLOAD = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalize (RFC 8785)', () => {
  test('sorts keys and removes spaces', () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  test('also sorts nested objects', () => {
    expect(canonicalize({ z: { y: 1, x: 2 }, a: [] })).toBe(
      '{"a":[],"z":{"x":2,"y":1}}',
    );
  });

  test('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  test('serializes null, booleans and strings with escaping', () => {
    expect(canonicalize({ n: null, t: true, f: false, s: 'a"b\\c\n' })).toBe(
      '{"f":false,"n":null,"s":"a\\"b\\\\c\\n","t":true}',
    );
  });

  test('preserves Unicode characters', () => {
    expect(canonicalize({ jogo: 'Tigrinho 🐯 ação' })).toBe(
      '{"jogo":"Tigrinho 🐯 ação"}',
    );
  });

  test('omits undefined properties, like JSON.stringify', () => {
    expect(canonicalize({ a: 1, ref: undefined })).toBe(canonicalize({ a: 1 }));
  });

  test('the example payload from the spec has the expected canonical form', () => {
    expect(canonicalize(BET_PAYLOAD)).toBe(
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
        '"money":{"amount":"25.00","currency":"BRL"},' +
        '"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a",' +
        '"roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
    );
  });

  test.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
  ])('rejects non-finite number (%s)', (_, value) => {
    expect(() => canonicalize({ value })).toThrow(CanonicalizationError);
  });

  test.each([
    ['Date', new Date('2026-01-01T00:00:00Z')],
    ['Money', Money.from({ amount: '1.00', currency: 'BRL' })],
    ['Map', new Map()],
  ])('rejects object that is not pure JSON (%s)', (_, value) => {
    expect(() => canonicalize({ value })).toThrow(CanonicalizationError);
  });

  test('rejects functions', () => {
    expect(() => canonicalize({ fn: () => 1 })).toThrow(CanonicalizationError);
  });
});

describe('canonicalHash', () => {
  test('SHA-256 of empty string matches the known vector', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('hash of the example payload matches the independently calculated value', () => {
    expect(canonicalHash(BET_PAYLOAD)).toBe(
      '629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344',
    );
  });

  test('another vector: object with array, boolean and null', () => {
    expect(canonicalHash({ b: [true, null, 'x'], a: 1 })).toBe(
      'eca8cfb31ab74533e1eb2f4c74d2d55dfe3c79ac704787e54be8647ea7777eb1',
    );
  });

  test('the order of keys does not change the hash', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(canonicalHash(reordered)).toBe(canonicalHash(BET_PAYLOAD));
  });

  test('any change in content changes the hash', () => {
    const changed = {
      ...BET_PAYLOAD,
      money: { amount: '25.01', currency: 'BRL' },
    };
    expect(canonicalHash(changed)).not.toBe(canonicalHash(BET_PAYLOAD));
  });

  test('the hash has the format required by the database', () => {
    expect(canonicalHash(BET_PAYLOAD)).toMatch(/^[0-9a-f]{64}$/);
  });
});
