/**
 * Contact service — see docs/CONTRACTS.md §3.
 */
import { query, queryOne } from './db';
import { notFound, validationError } from './errors';
import { classifyId } from './ids';
import { normalizePagination, toPaged } from './pagination';
import { mapContact, type ContactRow } from './rows';
import {
  buildUpdate,
  cleanEmail,
  cleanText,
  createConditions,
  pgErrorCode,
  resolveAccountId,
  searchTerm,
} from './sql';
import type {
  Contact,
  CreateContactInput,
  ListContactsParams,
  Paged,
  UpdateContactInput,
} from './types';
import { createContactSchema, updateContactSchema, validate } from './validation';

const BASE_COLUMNS = `id, salesforce_id, account_id, first_name, last_name, email, phone, title,
  source, salesforce_updated_at, synced_at, created_at, updated_at`;

const COLUMNS = `${BASE_COLUMNS.split(',')
  .map((column) => `c.${column.trim()}`)
  .join(', ')}, a.name AS account_name`;

const FROM = 'FROM contacts c LEFT JOIN accounts a ON a.id = c.account_id';

function requireAccountFilter(value: string, conditions: ReturnType<typeof createConditions>): string {
  const kind = classifyId(value);
  if (kind === 'uuid') return `c.account_id = ${conditions.param(value)}`;
  if (kind === 'salesforce') {
    return `c.account_id IN (SELECT id FROM accounts WHERE salesforce_id = ${conditions.param(value)})`;
  }
  throw validationError('account_id must be a uuid or a salesforce id', {
    account_id: 'invalid id',
  });
}

function translateWriteError(error: unknown): never {
  if (pgErrorCode(error) === '23503') {
    throw validationError('account_id does not exist', { account_id: 'unknown account' });
  }
  throw error;
}

export async function listContacts(params: ListContactsParams = {}): Promise<Paged<Contact>> {
  const { limit, offset } = normalizePagination(params);
  const conditions = createConditions();

  const search = searchTerm(params.search);
  if (search) {
    const placeholder = conditions.param(`%${search}%`);
    conditions.add(
      `(concat_ws(' ', c.first_name, c.last_name) ILIKE ${placeholder}
        OR COALESCE(c.email, '') ILIKE ${placeholder}
        OR COALESCE(c.title, '') ILIKE ${placeholder})`,
    );
  }
  if (params.account_id) conditions.add(requireAccountFilter(params.account_id, conditions));

  const where = conditions.where();
  const values = conditions.values;

  const rows = await query<ContactRow>(
    `SELECT ${COLUMNS} ${FROM} ${where}
      ORDER BY lower(concat_ws(' ', c.last_name, c.first_name)) ASC, c.id ASC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );
  const total = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total ${FROM} ${where}`,
    values,
  );

  return toPaged(rows.map(mapContact), total?.total ?? 0, { limit, offset });
}

export async function getContact(idOrSalesforceId: string): Promise<Contact> {
  const row = await findContact(idOrSalesforceId);
  if (!row) throw notFound('contact', idOrSalesforceId);
  return mapContact(row);
}

async function findContact(idOrId: string): Promise<ContactRow | null> {
  const kind = classifyId(idOrId);
  if (kind === 'uuid') {
    return queryOne<ContactRow>(`SELECT ${COLUMNS} ${FROM} WHERE c.id = $1`, [idOrId]);
  }
  if (kind === 'salesforce') {
    return queryOne<ContactRow>(`SELECT ${COLUMNS} ${FROM} WHERE c.salesforce_id = $1`, [idOrId]);
  }
  return null;
}

export async function createContact(input: CreateContactInput): Promise<Contact> {
  const data = validate(createContactSchema, input);
  const accountId = await resolveAccountId(data.account_id);

  let id: string | undefined;
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO contacts (first_name, last_name, email, phone, title, account_id, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'local') RETURNING id`,
      [
        cleanText(data.first_name),
        cleanText(data.last_name),
        cleanEmail(data.email),
        cleanText(data.phone),
        cleanText(data.title),
        accountId,
      ],
    );
    id = row?.id;
  } catch (error) {
    translateWriteError(error);
  }
  if (!id) throw new Error('failed to insert contact');
  return getContact(id);
}

export async function updateContact(id: string, input: UpdateContactInput): Promise<Contact> {
  const data = validate(updateContactSchema, input);
  const kind = classifyId(id);
  if (kind === 'unknown') throw notFound('contact', id);

  const accountId = data.account_id === undefined ? undefined : await resolveAccountId(data.account_id);

  const statement = buildUpdate({
    table: 'contacts c',
    patch: {
      first_name: data.first_name === undefined ? undefined : cleanText(data.first_name),
      last_name: data.last_name === undefined ? undefined : cleanText(data.last_name),
      email: data.email === undefined ? undefined : cleanEmail(data.email),
      phone: data.phone === undefined ? undefined : cleanText(data.phone),
      title: data.title === undefined ? undefined : cleanText(data.title),
      account_id: accountId,
    },
    key: { column: kind === 'uuid' ? 'c.id' : 'c.salesforce_id', value: id },
    returning: 'c.id',
  });

  if (!statement) return getContact(id);

  let updatedId: string | undefined;
  try {
    const row = await queryOne<{ id: string }>(statement.text, statement.values);
    updatedId = row?.id;
  } catch (error) {
    translateWriteError(error);
  }
  if (!updatedId) throw notFound('contact', id);
  return getContact(updatedId);
}
