import { IdGenerator } from '@/src/shared/application/ports/id-generator.port';

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
