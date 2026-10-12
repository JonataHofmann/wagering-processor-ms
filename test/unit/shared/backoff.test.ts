import { describe, expect, test } from 'bun:test';

import { ExponentialBackoff } from '@/src/shared/domain/backoff';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

const exact = new ExponentialBackoff({
  baseMs: 1_000,
  maxMs: 60_000,
  jitter: 'none',
});

describe('crescimento exponencial', () => {
  test('dobra a cada tentativa a partir da base', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => exact.delayFor(n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000,
    ]);
  });
});

describe('teto', () => {
  test('a espera para de crescer ao atingir o teto', () => {
    expect(exact.delayFor(7)).toBe(60_000); // 64 s seria o exponencial
    expect(exact.delayFor(8)).toBe(60_000);
    expect(exact.delayFor(20)).toBe(60_000);
  });

  test('tentativas absurdamente altas continuam no teto (sem Infinity nem NaN)', () => {
    expect(exact.delayFor(10_000)).toBe(60_000);
    expect(Number.isFinite(exact.delayFor(10_000))).toBe(true);
  });

  test('com jitter, nenhuma espera ultrapassa o teto', () => {
    const jittered = new ExponentialBackoff({
      baseMs: 1_000,
      maxMs: 60_000,
      jitter: 'equal',
    });
    for (let attempt = 1; attempt <= 50; attempt++) {
      for (let sample = 0; sample < 20; sample++) {
        expect(jittered.delayFor(attempt)).toBeLessThanOrEqual(60_000);
      }
    }
  });
});

describe('equal jitter', () => {
  test('random = 0 espera a metade do exponencial', () => {
    const lowest = new ExponentialBackoff({
      baseMs: 1_000,
      maxMs: 60_000,
      jitter: 'equal',
      random: () => 0,
    });
    expect(lowest.delayFor(3)).toBe(2_000); // metade de 4 s
  });

  test('random perto de 1 espera o exponencial inteiro', () => {
    const highest = new ExponentialBackoff({
      baseMs: 1_000,
      maxMs: 60_000,
      jitter: 'equal',
      random: () => 0.999_999,
    });
    expect(highest.delayFor(3)).toBe(4_000);
  });

  test('nunca espera menos que a metade (nunca zero)', () => {
    const jittered = new ExponentialBackoff({ baseMs: 1_000, maxMs: 60_000 });
    for (let i = 0; i < 200; i++) {
      expect(jittered.delayFor(1)).toBeGreaterThanOrEqual(500);
    }
  });

  test('random fora de [0, 1) é contido dentro dos limites', () => {
    const broken = new ExponentialBackoff({
      baseMs: 1_000,
      maxMs: 60_000,
      random: () => 1.5,
    });
    expect(broken.delayFor(3)).toBeLessThanOrEqual(4_000);
  });

  test('sempre devolve milissegundos inteiros', () => {
    const jittered = new ExponentialBackoff({ baseMs: 1_000, maxMs: 60_000 });
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(Number.isInteger(jittered.delayFor(attempt))).toBe(true);
    }
  });
});

describe('configuração inválida é bug', () => {
  test.each([
    ['base zero', { baseMs: 0, maxMs: 10 }],
    ['base fracionária', { baseMs: 1.5, maxMs: 10 }],
    ['teto menor que a base', { baseMs: 1_000, maxMs: 500 }],
  ])('%s', (_, options) => {
    expect(() => new ExponentialBackoff(options)).toThrow(
      InvariantViolationError,
    );
  });

  test.each([0, -1, 1.5])('tentativa %p', (attempt) => {
    expect(() => exact.delayFor(attempt)).toThrow(InvariantViolationError);
  });
});
