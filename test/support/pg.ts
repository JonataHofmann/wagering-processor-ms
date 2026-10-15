import { Client, type Pool, type PoolClient, type QueryResultRow } from 'pg';

/** Runs `fn` in a real transaction and COMMITs (deferred triggers fire on COMMIT). */
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
 * Resolves with the error's SQLSTATE, or `undefined` if the operation succeeded.
 * Lets you write: expect(await sqlState(op)).toBe('23505').
 */
export function sqlState(
  operation: Promise<unknown>,
): Promise<string | undefined> {
  return operation.then(
    () => undefined,
    (error: unknown) => (error as { code?: string }).code ?? 'NO_SQLSTATE',
  );
}

/** Opens a standalone connection, runs a query, and closes it. */
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
