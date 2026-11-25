import { afterAll, describe, expect, it } from 'vitest';
import { closePool, query, queryOne } from './db.js';

describe('database foundation', () => {
  it('connects and reads the schema', async () => {
    const rows = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = rows.map((row) => row.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'accounts',
        'cdc_checkpoints',
        'cdc_events',
        'contacts',
        'leads',
        'opportunities',
        'sync_runs',
      ]),
    );
  });

  it('stamps updated_at through the trigger', async () => {
    const created = await queryOne<{ id: string; updated_at: Date }>(
      `INSERT INTO accounts (name, source) VALUES ($1, 'local') RETURNING id, updated_at`,
      [`vitest-scaffold-${Date.now()}`],
    );
    expect(created).toBeTruthy();

    await query(`UPDATE accounts SET name = $2 WHERE id = $1`, [created!.id, 'renamed']);
    const after = await queryOne<{ updated_at: Date }>(
      `SELECT updated_at FROM accounts WHERE id = $1`,
      [created!.id],
    );
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(created!.updated_at).getTime(),
    );
    await query(`DELETE FROM accounts WHERE id = $1`, [created!.id]);
  });

  it('rejects an unknown lead status', async () => {
    await expect(
      query(`INSERT INTO leads (full_name, email, status) VALUES ('x', 'x@example.com', 'bogus')`),
    ).rejects.toThrow();
  });

  afterAll(async () => {
    await closePool();
  });
});
