export const FailureCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds: 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  WalletNotFound: 'WALLET_NOT_FOUND',
  WalletPlayerMismatch: 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  ReferenceContextMismatch: 'REFERENCE_CONTEXT_MISMATCH',
  ReferenceInvalidKind: 'REFERENCE_INVALID_KIND',
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed: 'REFERENCE_ALREADY_REVERSED',
  AmountMismatch: 'AMOUNT_MISMATCH',
  InfraRetriesExhausted: 'INFRA_RETRIES_EXHAUSTED',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

/** O que o provedor deve fazer ao receber o código. */
export type ProviderAction =
  | 'DO_NOT_RETRY' // a situação não muda reenviando
  | 'FIX_PAYLOAD' // corrigir os dados e enviar como nova operação
  | 'RETRY_LATER' // reenviar a mesma operação depois
  | 'ESCALATE'; // exige análise humana

export interface FailureCodeInfo {
  /** status final da transação que carrega este código */
  status: 'REJECTED' | 'FAILED';
  providerAction: ProviderAction;
  description: string;
}

export const FAILURE_CODES: Readonly<Record<FailureCode, FailureCodeInfo>> = {
  INSUFFICIENT_FUNDS: {
    status: 'REJECTED',
    providerAction: 'DO_NOT_RETRY',
    description: 'Saldo insuficiente para a aposta',
  },
  REVERSAL_INSUFFICIENT_FUNDS: {
    status: 'REJECTED',
    providerAction: 'ESCALATE',
    description:
      'Reversão deixaria o saldo negativo (ex.: rollback de um WIN já gasto)',
  },
  CURRENCY_MISMATCH: {
    status: 'REJECTED',
    providerAction: 'FIX_PAYLOAD',
    description: 'Moeda da operação diferente da moeda da wallet',
  },
  WALLET_NOT_FOUND: {
    status: 'REJECTED',
    providerAction: 'FIX_PAYLOAD',
    description: 'Wallet inexistente',
  },
  WALLET_PLAYER_MISMATCH: {
    status: 'REJECTED',
    providerAction: 'FIX_PAYLOAD',
    description: 'A wallet não pertence ao jogador informado',
  },
  REFERENCE_NOT_FOUND: {
    status: 'REJECTED',
    providerAction: 'ESCALATE',
    description: 'Transação referenciada não chegou dentro do TTL',
  },
  REFERENCE_CONTEXT_MISMATCH: {
    status: 'REJECTED',
    providerAction: 'FIX_PAYLOAD',
    description:
      'Referência de outro provedor, jogador, wallet, moeda ou rodada',
  },
  REFERENCE_INVALID_KIND: {
    status: 'REJECTED',
    providerAction: 'FIX_PAYLOAD',
    description: 'Tipo de referência não permitido (ex.: REFUND de um WIN)',
  },
  REFERENCE_NOT_PROCESSED: {
    status: 'REJECTED',
    providerAction: 'DO_NOT_RETRY',
    description:
      'A transação referenciada não foi aplicada (rejeitada ou com falha)',
  },
  REFERENCE_ALREADY_REVERSED: {
    status: 'REJECTED',
    providerAction: 'DO_NOT_RETRY',
    description: 'A transação referenciada já foi revertida',
  },
  AMOUNT_MISMATCH: {
    status: 'REJECTED',
    providerAction: 'FIX_PAYLOAD',
    description: 'Valor da reversão diferente do valor da referência',
  },
  INFRA_RETRIES_EXHAUSTED: {
    status: 'FAILED',
    providerAction: 'RETRY_LATER',
    description:
      'Falha permanente de infraestrutura após esgotar as tentativas',
  },
};
