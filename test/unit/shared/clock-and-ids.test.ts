import { FixedClock, SequentialIdGenerator } from '@/test/support/fakes';
import { describe, expect, test } from 'bun:test';

import { SystemClock } from '@/src/shared/infrastructure/system-clock';
import { UuidV7Generator } from '@/src/shared/infrastructure/uuid-v7.generator';

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('UuidV7Generator', () => {
  const ids = new UuidV7Generator();

  test('generates a valid UUID version 7', () => {
    expect(ids.next()).toMatch(UUID_V7);
  });

  test('does not repeat across 10 thousand generations', () => {
    const generated = new Set(Array.from({ length: 10_000 }, () => ids.next()));
    expect(generated.size).toBe(10_000);
  });

  test('ids from later milliseconds sort after', async () => {
    const first = ids.next();
    await Bun.sleep(2);
    const second = ids.next();
    expect(second > first).toBe(true);
  });
});

describe('SystemClock', () => {
  test('returns the current time', () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('test fakes', () => {
  test('FixedClock only advances when told to', () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    clock.advance(15 * 60_000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:15:00.000Z');
  });

  test('FixedClock returns copies: the receiver cannot alter the clock', () => {
    const clock = new FixedClock();
    clock.now().setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  test('SequentialIdGenerator produces valid and predictable UUIDs', () => {
    const ids = new SequentialIdGenerator();
    expect(ids.next()).toBe('00000000-0000-7000-8000-000000000001');
    expect(ids.next()).toBe('00000000-0000-7000-8000-000000000002');
    expect(ids.next()).toMatch(UUID_V7);
  });
});
