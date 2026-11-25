/**
 * Account service — see docs/CONTRACTS.md §3.
 */
import { query, queryOne } from './db';
import { notFound, validationError } from './errors';
import { classifyId } from './ids';
import { DEFAULT_SEARCH_LIMIT, normalizeLimit, normalizePagination, toPaged } from './pagination';
import { mapAccount, type AccountRow } from './rows';
import { buildUpdate, cleanText, createConditions, pgErrorCode, searchTerm } from './sql';
import type {
  Account,
  CreateAccountInput,
  EntitySource,
  ListAccountsParams,
  Paged,
  UpdateAccountInput,
} from './types';
import {
  createAccountSchema,
  entitySourceSchema,
  updateAccountSchema,
  validate,
} from './validation';

const BASE_COLUMNS = `id, salesforce_id, name, industry, website, billing_country,
  owner_name, source, salesforce_updated_at, synced_at, created_at, updated_at`;

const COLUMNS = BASE_COLUMNS.split(',')
  .map((column) => `a.${column.trim()}`)
  .join(', ');

function requireSource(source: EntitySource | undefined): EntitySource | undefined {
  if (source === undefined || source === null) return undefined;
  const parsed = entitySourceSchema.safeParse(source);
  if (!parsed.success) {
    throw validationError('source must be one of salesforce, local', { source: 'invalid source' });
  }
  return parsed.data;
}

export async function listAccounts(params: ListAccountsParams = {}): Promise<Paged<Account>> {
  const { limit, offset } = normalizePagination(params);
  const source = requireSource(params.source);
  const conditions = createConditions();

  const search = searchTerm(params.search);
  if (search) {
    const placeholder = conditions.param(`%${search}%`);
    conditions.add(
      `(a.name ILIKE ${placeholder} OR COALESCE(a.industry, '') ILIKE ${placeholder}
        OR COALESCE(a.website, '') ILIKE ${placeholder})`,
    );
  }
  if (source) conditions.add(`a.source = ${conditions.param(source)}`);

  const where = conditions.where();
  const values = conditions.values;

  const rows = await query<AccountRow>(
    `SELECT ${COLUMNS} FROM accounts a ${where}
      ORDER BY lower(a.name) ASC, a.id ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );
  const total = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM accounts a ${where}`,
    values,
  );

  return toPaged(rows.map(mapAccount), total?.total ?? 0, { limit, offset });
}

/** Accepts a local uuid or a Salesforce id; throws `not_found` otherwise. */
export async function getAccount(idOrSalesforceId: string): Promise<Account> {
  const row = await findAccount(idOrSalesforceId);
  if (!row) throw notFound('account', idOrSalesforceId);
  return mapAccount(row);
}

async function findAccount(idOrId: string): Promise<AccountRow | null> {
  const kind = classifyId(idOrId);
  if (kind === 'uuid') {
    return queryOne<AccountRow>(`SELECT ${COLUMNS} FROM accounts a WHERE a.id = $1`, [idOrId]);
  }
  if (kind === 'salesforce') {
    return queryOne<AccountRow>(`SELECT ${COLUMNS} FROM accounts a WHERE a.salesforce_id = $1`, [
      idOrId,
    ]);
  }
  return null;
}

export async function createAccount(input: CreateAccountInput): Promise<Account> {
  const data = validate(createAccountSchema, input);
  const row = await queryOne<AccountRow>(
    `INSERT INTO accounts (name, industry, website, billing_country, owner_name, source)
     VALUES ($1, $2, $3, $4, $5, 'local') RETURNING ${BASE_COLUMNS}`,
    [
      data.name,
      cleanText(data.industry),
      cleanText(data.website),
      cleanText(data.billing_country),
      cleanText(data.owner_name),
    ],
  );
  if (!row) throw new Error('failed to insert account');
  return mapAccount(row);
}

export async function updateAccount(id: string, input: UpdateAccountInput): Promise<Account> {
  const data = validate(updateAccountSchema, input);
  const kind = classifyId(id);
  if (kind === 'unknown') throw notFound('account', id);

  const statement = buildUpdate({
    table: 'accounts a',
    patch: {
      name: data.name,
      industry: data.industry === undefined ? undefined : cleanText(data.industry),
      website: data.website === undefined ? undefined : cleanText(data.website),
      billing_country:
        data.billing_country === undefined ? undefined : cleanText(data.billing_country),
      owner_name: data.owner_name === undefined ? undefined : cleanText(data.owner_name),
    },
    key: { column: kind === 'uuid' ? 'a.id' : 'a.salesforce_id', value: id },
    returning: COLUMNS,
  });

  if (!statement) return getAccount(id);

  let row: AccountRow | null;
  try {
    row = await queryOne<AccountRow>(statement.text, statement.values);
  } catch (error) {
    if (pgErrorCode(error) === '23505') {
      throw validationError('account already exists', { name: 'duplicate' });
    }
    throw error;
  }
  if (!row) throw notFound('account', id);
  return mapAccount(row);
}

export async function searchAccounts(term: string, limit?: number): Promise<Account[]> {
  const search = searchTerm(term);
  if (!search) return [];
  const capped = normalizeLimit(limit, DEFAULT_SEARCH_LIMIT);
  const rows = await query<AccountRow>(
    `SELECT ${COLUMNS} FROM accounts a
      WHERE a.name ILIKE $1
      ORDER BY lower(a.name) ASC, a.id ASC LIMIT $2`,
    [`%${search}%`, capped],
  );
  return rows.map(mapAccount);
}
