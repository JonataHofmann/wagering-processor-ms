import {
  MAX_CONSUMER_NAME_LENGTH,
  MAX_MESSAGE_ID_LENGTH,
  PAYLOAD_HASH_PATTERN,
} from '@/src/modules/messaging/constants/inbox-message.constants';

import { assertIdentifier } from '@/src/modules/messaging/util/assert-identifier';
import { InvariantViolationError } from '@/src/shared/error/invariant-violation-error';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  /**
   * Registra o recebimento. O envelope da mensagem já foi validado pelo consumer:
   * dados inválidos aqui são bug, não mensagem ruim (mensagem ruim vai para a DLQ antes).
   */
  static receive(props: ReceiveInboxProps): InboxMessage {
    assertIdentifier('messageId', props.messageId, MAX_MESSAGE_ID_LENGTH);
    assertIdentifier(
      'consumerName',
      props.consumerName,
      MAX_CONSUMER_NAME_LENGTH,
    );
    if (!PAYLOAD_HASH_PATTERN.test(props.payloadHash)) {
      throw new InvariantViolationError(
        `payloadHash must be 64 lowercase hex chars, got "${props.payloadHash}"`,
      );
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvariantViolationError(
        `inbox message ${this.consumerName}/${this.messageId} already processed`,
      );
    }
    this._processedAt = at;
  }

  /** Mesmo messageId com conteúdo diferente é anomalia (vai para a DLQ), não duplicata. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }
}
