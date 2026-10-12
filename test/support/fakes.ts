import { Clock } from '@/src/shared/application/ports/clock.port';
import { IdGenerator } from '@/src/shared/application/ports/id-generator.port';

/** Relógio controlado pelo teste: só anda quando mandarem. */
export class FixedClock implements Clock {
  private current: Date;

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current); // cópia: quem recebe não altera o relógio
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(at: Date | string): void {
    this.current = new Date(at);
  }
}

/** Ids previsíveis e válidos como UUID: 00000000-0000-7000-8000-000000000001, ...002, ... */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `00000000-0000-7000-8000-${this.counter.toString(16).padStart(12, '0')}`;
  }
}
