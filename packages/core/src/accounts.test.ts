import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccount,
  getAccount,
  listAccounts,
  searchAccounts,
  updateAccount,
} from './accounts';
import { closePool, query, queryOne } from './db';
import { AppError } from './errors';

const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prefix = `vitest-accounts-${run}`;
const createdIds: string[] = [];

function unique(label: string): string {
  return `${prefix}-${label}`;
}

beforeAll(async () => {
  // A salesforce-sourced row, to prove lookups by Salesforce id work.
  const row = await queryOne<{ id: string }>(
    `INSERT INTO accounts (salesforce_id, name, industry, source, salesforce_updated_at, synced_at)
     VALUES ($1, $2, 'Energy', 'salesforce', now(), now()) RETURNING id`,
    [`001${run.replace(/[^a-zA-Z0-9]/g, '').slice(0, 15)}`, unique('sf-account')],
  );
  if (row) createdIds.push(row.id);
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [createdIds]);
  }
  await closePool();
});

describe('accounts service', () => {
  it('creates and reads an account with camelCase fields', async () => {
    const account = await createAccount({
      name: unique('acme'),
      industry: 'Real Estate',
      website: 'https://acme.example',
      billing_country: 'US',
      owner_name: 'Ada Lovelace',
    });
    createdIds.push(account.id);

    expect(account.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(account.salesforce_id).toBeNull();
    expect(account.source).toBe('local');
    expect(account.industry).toBe('Real Estate');
    expect(account.salesforce_updated_at).toBeNull();
    expect(Number.isNaN(Date.parse(account.created_at))).toBe(false);
    expect(Number.isNaN(Date.parse(account.updated_at))).toBe(false);

    const fetched = await getAccount(account.id);
    expect(fetched).toEqual(account);
  });

  it('reads an account by Salesforce id', async () => {
    const sfid = await queryOne<{ salesforce_id: string }>(
      `SELECT salesforce_id FROM accounts WHERE id = $1`,
      [createdIds[0]],
    );
    const account = await getAccount(sfid!.salesforce_id);
    expect(account.id).toBe(createdIds[0]);
    expect(account.source).toBe('salesforce');
  });

  it('rejects invalid input with an AppError', async () => {
    await expect(createAccount({ name: '' })).rejects.toBeInstanceOf(AppError);
    await expect(createAccount({} as never)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('throws not_found for unknown ids', async () => {
    await expect(getAccount('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    await expect(getAccount('not-an-id')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists with search, source filter, ordering and pagination', async () => {
    const names = [`${prefix}-list-a`, `${prefix}-list-b`, `${prefix}-list-c`];
    for (const name of names) {
      const account = await createAccount({ name });
      createdIds.push(account.id);
    }

    const firstPage = await listAccounts({ search: `${prefix}-list-`, limit: 2 });
    expect(firstPage.total).toBe(3);
    expect(firstPage.limit).toBe(2);
    expect(firstPage.offset).toBe(0);
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.data.map((row) => row.name)).toEqual([names[0], names[1]]);

    const secondPage = await listAccounts({ search: `${prefix}-list-`, limit: 2, offset: 2 });
    expect(secondPage.total).toBe(3);
    expect(secondPage.data.map((row) => row.name)).toEqual([names[2]]);

    const local = await listAccounts({ search: `${prefix}-list-`, source: 'local' });
    expect(local.total).toBe(3);

    const salesforceOnly = await listAccounts({ search: `${prefix}-list-`, source: 'salesforce' });
    expect(salesforceOnly.total).toBe(0);
  });

  it('caps limit at 200 and defaults to 50', async () => {
    const page = await listAccounts({ limit: 10_000 });
    expect(page.limit).toBe(200);
    expect(page.offset).toBe(0);

    const defaults = await listAccounts();
    expect(defaults.limit).toBe(50);
  });

  it('rejects an invalid source filter', async () => {
    await expect(listAccounts({ source: 'bogus' as never })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('updates a subset of fields and bumps updated_at', async () => {
    const account = await createAccount({ name: unique('update'), industry: 'Tech' });
    createdIds.push(account.id);

    const updated = await updateAccount(account.id, { industry: 'Finance', website: null });
    expect(updated.industry).toBe('Finance');
    expect(updated.website).toBeNull();
    expect(updated.name).toBe(account.name);
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(account.updated_at).getTime(),
    );

    const noop = await updateAccount(account.id, {});
    expect(noop.id).toBe(account.id);

    await expect(
      updateAccount('00000000-0000-4000-8000-000000000000', { name: 'ghost' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateAccount(account.id, { name: '' })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('searches by name ordered alphabetically', async () => {
    const a = await createAccount({ name: `${prefix}-search-bravo` });
    const b = await createAccount({ name: `${prefix}-search-alpha` });
    createdIds.push(a.id, b.id);

    const results = await searchAccounts(`${prefix}-search-`);
    expect(results.map((row) => row.name)).toEqual([
      `${prefix}-search-alpha`,
      `${prefix}-search-bravo`,
    ]);
    expect(await searchAccounts('   ')).toEqual([]);
  });
});
