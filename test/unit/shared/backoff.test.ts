import { describe, expect, test } from 'bun:test';

import { ExponentialBackoff } from '@/src/shared/domain/backoff';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

const exact = new ExponentialBackoff({
  baseMs: 1_000,
  maxMs: 60_000,
  jitter: 'none',
});

describe('exponential growth', () => {
  test('doubles on each attempt starting from the base', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => exact.delayFor(n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000,
    ]);
  });
});

describe('ceiling', () => {
  test('the wait stops growing once it reaches the ceiling', () => {
    expect(exact.delayFor(7)).toBe(60_000); // 64s would be the exponential value
    expect(exact.delayFor(8)).toBe(60_000);
    expect(exact.delayFor(20)).toBe(60_000);
  });

  test('absurdly high attempts stay at the ceiling (no Infinity or NaN)', () => {
    expect(exact.delayFor(10_000)).toBe(60_000);
    expect(Number.isFinite(exact.delayFor(10_000))).toBe(true);
  });

  test('with jitter, no wait exceeds the ceiling', () => {
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
  test('random = 0 waits half of the exponential value', () => {
    const lowest = new ExponentialBackoff({
      baseMs: 1_000,
      maxMs: 60_000,
      jitter: 'equal',
      random: () => 0,
    });
    expect(lowest.delayFor(3)).toBe(2_000); // half of 4s
  });

  test('random close to 1 waits the full exponential value', () => {
    const highest = new ExponentialBackoff({
      baseMs: 1_000,
      maxMs: 60_000,
      jitter: 'equal',
      random: () => 0.999_999,
    });
    expect(highest.delayFor(3)).toBe(4_000);
  });

  test('never waits less than half (never zero)', () => {
    const jittered = new ExponentialBackoff({ baseMs: 1_000, maxMs: 60_000 });
    for (let i = 0; i < 200; i++) {
      expect(jittered.delayFor(1)).toBeGreaterThanOrEqual(500);
    }
  });

  test('random outside [0, 1) is clamped within bounds', () => {
    const broken = new ExponentialBackoff({
      baseMs: 1_000,
      maxMs: 60_000,
      random: () => 1.5,
    });
    expect(broken.delayFor(3)).toBeLessThanOrEqual(4_000);
  });

  test('always returns integer milliseconds', () => {
    const jittered = new ExponentialBackoff({ baseMs: 1_000, maxMs: 60_000 });
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(Number.isInteger(jittered.delayFor(attempt))).toBe(true);
    }
  });
});

describe('invalid configuration is a bug', () => {
  test.each([
    ['zero base', { baseMs: 0, maxMs: 10 }],
    ['fractional base', { baseMs: 1.5, maxMs: 10 }],
    ['ceiling less than the base', { baseMs: 1_000, maxMs: 500 }],
  ])('%s', (_, options) => {
    expect(() => new ExponentialBackoff(options)).toThrow(
      InvariantViolationError,
    );
  });

  test.each([0, -1, 1.5])('attempt %p', (attempt) => {
    expect(() => exact.delayFor(attempt)).toThrow(InvariantViolationError);
  });
});
