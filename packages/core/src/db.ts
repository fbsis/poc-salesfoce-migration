import { Pool, type PoolClient, type QueryResultRow } from 'pg';

/**
 * Single connection pool per process. Next.js dev mode reloads modules on every
 * edit, so the pool is cached on globalThis to avoid leaking connections.
 */
const globalForPool = globalThis as unknown as { __pocPool?: Pool };

export function getPool(): Pool {
  if (!globalForPool.__pocPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    globalForPool.__pocPool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    globalForPool.__pocPool.on('error', (error) => {
      console.error('[db] idle client error', error.message);
    });
  }
  return globalForPool.__pocPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params as never[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
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

export async function closePool(): Promise<void> {
  if (globalForPool.__pocPool) {
    await globalForPool.__pocPool.end();
    globalForPool.__pocPool = undefined;
  }
}
