/** SQLSTATEs que a aplicação trata de forma específica. */
export const SqlState = {
  UniqueViolation: '23505',
  ForeignKeyViolation: '23503',
  CheckViolation: '23514',
  InsufficientPrivilege: '42501',
  LockNotAvailable: '55P03', // lock_timeout
  QueryCanceled: '57014', // statement_timeout
  SerializationFailure: '40001',
  DeadlockDetected: '40P01',
  LedgerAppendOnly: 'WL001',
  LedgerInconsistency: 'WL002',
  TransactionImmutable: 'WL003',
  WalletImmutable: 'WL004',
} as const;

export function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
    ? code
    : undefined;
}

/** Nome da constraint violada, quando o banco informa. */
export function constraintOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  return (
    sqlStateOf(error) === SqlState.UniqueViolation &&
    (constraint === undefined || constraintOf(error) === constraint)
  );
}

/** Falhas que podem dar certo se tentadas de novo (viram 503 / retry do SQS). */
export function isTransientDatabaseError(error: unknown): boolean {
  const state = sqlStateOf(error);
  if (state === undefined) return isConnectionError(error);
  return (
    state === SqlState.LockNotAvailable ||
    state === SqlState.QueryCanceled ||
    state === SqlState.SerializationFailure ||
    state === SqlState.DeadlockDetected ||
    state.startsWith('08')
  ); // classe 08: connection exception
}

/** Violação dos triggers de integridade: sempre bug no código. */
export function isIntegrityViolation(error: unknown): boolean {
  const state = sqlStateOf(error);
  return state !== undefined && state.startsWith('WL');
}

function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE'
  );
}
