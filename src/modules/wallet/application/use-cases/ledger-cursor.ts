import { RequestValidationError } from '@/src/shared/error/application-errors';

/**
 * Cursor opaco da paginação do ledger: base64url de {"v": walletVersion}.
 * Estável porque o ledger é imutável e walletVersion é única por wallet.
 * Opaco: o cliente devolve o que recebeu, sem depender do formato interno.
 */
export const LedgerCursor = {
  encode(walletVersion: number): string {
    return Buffer.from(JSON.stringify({ v: walletVersion }), 'utf8').toString(
      'base64url',
    );
  },

  decode(cursor: string): number {
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      );
      const version = (parsed as { v?: unknown } | null)?.v;
      if (
        typeof version === 'number' &&
        Number.isInteger(version) &&
        version >= 0
      )
        return version;
    } catch {
      // cai no erro abaixo
    }
    throw new RequestValidationError([
      { field: 'cursor', message: 'is invalid' },
    ]);
  },
};
