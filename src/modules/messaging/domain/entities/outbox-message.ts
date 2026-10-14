import {
  MAX_ERROR_LENGTH,
  OUTBOX_RETRY_BACKOFF,
} from '@/src/modules/messaging/domain/outbox-message.constants';

import { ExponentialBackoff } from '@/src/shared/domain/backoff';
import { IntegrationEvent } from '@/src/shared/domain/integration-event';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
  lastError?: string;
}

export interface ScheduleRetryOptions {
  /** motivo da falha, para diagnóstico (truncado em 500 caracteres) */
  error?: string;
  /** política de backoff; padrão OUTBOX_RETRY_BACKOFF */
  backoff?: ExponentialBackoff;
}

export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;

  private _attempts: number;
  private _nextAttemptAt: Date;
  private _publishedAt: Date | undefined;
  private _lastError: string | undefined;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.eventVersion = state.eventVersion;
    this.payload = state.payload;
    this.occurredAt = state.occurredAt;
    this._attempts = state.attempts;
    this._nextAttemptAt = state.nextAttemptAt;
    this._publishedAt = state.publishedAt;
    this._lastError = state.lastError;
  }

  /**
   * Transforma um evento de integração no registro da outbox.
   * O payload é o envelope serializado (toJSON), já JSON puro.
   * O evento nasce vencido: pode ser publicado imediatamente.
   */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      eventVersion: event.version,
      payload: Object.freeze({ ...envelope }),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Pendente e com a próxima tentativa já vencida. */
  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(
        `outbox message ${this.id} already published`,
      );
    }
    this._publishedAt = at;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt pelo backoff, a partir de `now`. */
  scheduleRetry(now: Date, options: ScheduleRetryOptions = {}): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(
        `outbox message ${this.id} already published; nothing to retry`,
      );
    }
    const backoff = options.backoff ?? OUTBOX_RETRY_BACKOFF;

    this._attempts += 1;
    this._nextAttemptAt = new Date(
      now.getTime() + backoff.delayFor(this._attempts),
    );
    this._lastError = options.error?.slice(0, MAX_ERROR_LENGTH);
  }
}
