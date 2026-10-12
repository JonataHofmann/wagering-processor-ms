import { Clock } from '@/src/shared/application/ports/clock.port';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
