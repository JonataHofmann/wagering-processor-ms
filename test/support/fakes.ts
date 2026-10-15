import { Clock } from '@/src/shared/application/ports/clock.port';
import { IdGenerator } from '@/src/shared/application/ports/id-generator.port';

/** Clock controlled by the test: only moves when told to. */
export class FixedClock implements Clock {
  private current: Date;

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current); // copy: whoever receives it can't alter the clock
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(at: Date | string): void {
    this.current = new Date(at);
  }
}

/** Predictable, UUID-valid ids: 00000000-0000-7000-8000-000000000001, ...002, ... */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `00000000-0000-7000-8000-${this.counter.toString(16).padStart(12, '0')}`;
  }
}
