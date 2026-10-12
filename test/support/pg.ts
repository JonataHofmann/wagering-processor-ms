import { Client, type Pool, type PoolClient, type QueryResultRow } from 'pg';

/** Executa `fn` numa transação real e faz COMMIT (triggers deferidos disparam no COMMIT). */
export async function inTx<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Resolve com o SQLSTATE do erro, ou `undefined` se a operação passou.
 * Permite escrever: expect(await sqlState(op)).toBe('23505').
 */
export function sqlState(
  operation: Promise<unknown>,
): Promise<string | undefined> {
  return operation.then(
    () => undefined,
    (error: unknown) => (error as { code?: string }).code ?? 'NO_SQLSTATE',
  );
}

/** Abre uma conexão avulsa, roda uma query e fecha. */
export async function queryOnce<T extends QueryResultRow>(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}
