export const FailureCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds: 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  /**
   * NUNCA aparece em WagerTransaction.failureCode: wallet inexistente corta o fluxo
   * em ResourceNotFoundError (404) antes de qualquer WagerTransaction ser criada —
   * não há transação pra persistir o código. Existe aqui só para completar a
   * taxonomia documentada ao provedor (ver ARCHITECTURE.pt.md §6.9, "não persistido").
   */
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
    description: 'Insufficient balance for the bet',
  },
  REVERSAL_INSUFFICIENT_FUNDS: {
    status: 'REJECTED',
    providerAction: 'ESCALATE',
    description:
      'Reversal would leave the balance negative (e.g. rollback of an already-spent WIN)',
  },
  CURRENCY_MISMATCH: {
    status: 'REJECTED',
    providerAction: 'FIX_PAYLOAD',
    description: 'Operation currency differs from the wallet currency',
  },
  WALLET_NOT_FOUND: {
    // status nominal: na prática vira HTTP 404 antes de existir uma transação
    // persistida com este failureCode (ver comentário em WalletNotFound acima).
    status: 'REJECTED',
    providerAction: 'FIX_PAYLOAD',
    description: 'Wallet does not exist (never persisted: results in HTTP 404)',
  },
  WALLET_PLAYER_MISMATCH: {
    status: 'REJECTED',
    providerAction: 'FIX_PAYLOAD',
    description: 'The wallet does not belong to the given player',
  },
  REFERENCE_NOT_FOUND: {
    status: 'REJECTED',
    providerAction: 'ESCALATE',
    description: 'Referenced transaction did not arrive within the TTL',
  },
  REFERENCE_CONTEXT_MISMATCH: {
    status: 'REJECTED',
    providerAction: 'FIX_PAYLOAD',
    description:
      'Reference from another provider, player, wallet, currency or round',
  },
  REFERENCE_INVALID_KIND: {
    status: 'REJECTED',
    providerAction: 'FIX_PAYLOAD',
    description: 'Reference kind not allowed (e.g. REFUND of a WIN)',
  },
  REFERENCE_NOT_PROCESSED: {
    status: 'REJECTED',
    providerAction: 'DO_NOT_RETRY',
    description:
      'The referenced transaction was not applied (rejected or failed)',
  },
  REFERENCE_ALREADY_REVERSED: {
    status: 'REJECTED',
    providerAction: 'DO_NOT_RETRY',
    description: 'The referenced transaction has already been reversed',
  },
  AMOUNT_MISMATCH: {
    status: 'REJECTED',
    providerAction: 'FIX_PAYLOAD',
    description: 'Reversal amount differs from the reference amount',
  },
  INFRA_RETRIES_EXHAUSTED: {
    status: 'FAILED',
    providerAction: 'RETRY_LATER',
    description:
      'Permanent infrastructure failure after exhausting retries',
  },
};
