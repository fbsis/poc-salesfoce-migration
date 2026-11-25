/**
 * Opportunity service — see docs/CONTRACTS.md §3.
 * `amount` is a `numeric(14,2)` column: it is written as a fixed-2-decimal
 * string and returned as a string (never a JS float).
 */
import { query, queryOne } from './db';
import { notFound, validationError } from './errors';
import { classifyId } from './ids';
import { normalizePagination, toPaged } from './pagination';
import { mapOpportunity, type OpportunityRow } from './rows';
import {
  buildUpdate,
  cleanText,
  createConditions,
  pgErrorCode,
  resolveAccountId,
  searchTerm,
} from './sql';
import type {
  CreateOpportunityInput,
  ListOpportunitiesParams,
  Opportunity,
  OpportunityStage,
  Paged,
  UpdateOpportunityInput,
} from './types';
import {
  amountSchema,
  createOpportunitySchema,
  opportunityStageSchema,
  updateOpportunitySchema,
  validate,
} from './validation';

const BASE_COLUMNS = `id, salesforce_id, account_id, name, stage, amount, close_date,
  owner_name, probability, source, salesforce_updated_at, synced_at, created_at, updated_at`;

const SELECT_COLUMNS = `${BASE_COLUMNS.split(',')
  .map((column) => {
    const name = column.trim();
    // `date` columns are cast to text so the boundary never depends on the
    // driver's local-midnight Date parsing.
    return name === 'close_date' ? 'o.close_date::text AS close_date' : `o.${name}`;
  })
  .join(', ')}, a.name AS account_name`;

const FROM = 'FROM opportunities o LEFT JOIN accounts a ON a.id = o.account_id';

function requireStage(stage: OpportunityStage): OpportunityStage {
  const parsed = opportunityStageSchema.safeParse(stage);
  if (!parsed.success) {
    throw validationError('stage is not a valid opportunity stage', { stage: 'invalid stage' });
  }
  return parsed.data;
}

function requireAccountFilter(value: string, conditions: ReturnType<typeof createConditions>): string {
  const kind = classifyId(value);
  if (kind === 'uuid') return `o.account_id = ${conditions.param(value)}`;
  if (kind === 'salesforce') {
    return `o.account_id IN (SELECT id FROM accounts WHERE salesforce_id = ${conditions.param(value)})`;
  }
  throw validationError('account_id must be a uuid or a salesforce id', {
    account_id: 'invalid id',
  });
}

/** Normalise an amount input to a `numeric(14,2)` literal. */
function toAmount(value: number | string): string {
  const parsed = amountSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError('amount must be a number >= 0 with at most 2 decimals', {
      amount: 'invalid amount',
    });
  }
  return Number(value).toFixed(2);
}

function translateWriteError(error: unknown): never {
  if (pgErrorCode(error) === '23503') {
    throw validationError('account_id does not exist', { account_id: 'unknown account' });
  }
  throw error;
}

export async function listOpportunities(
  params: ListOpportunitiesParams = {},
): Promise<Paged<Opportunity>> {
  const { limit, offset } = normalizePagination(params);
  const conditions = createConditions();

  const search = searchTerm(params.search);
  if (search) {
    const placeholder = conditions.param(`%${search}%`);
    conditions.add(
      `(o.name ILIKE ${placeholder} OR COALESCE(a.name, '') ILIKE ${placeholder}
        OR COALESCE(o.owner_name, '') ILIKE ${placeholder})`,
    );
  }
  if (params.stage !== undefined && params.stage !== null) {
    conditions.add(`o.stage = ${conditions.param(requireStage(params.stage))}`);
  }
  if (params.account_id) conditions.add(requireAccountFilter(params.account_id, conditions));

  const where = conditions.where();
  const values = conditions.values;

  const rows = await query<OpportunityRow>(
    `SELECT ${SELECT_COLUMNS} ${FROM} ${where}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );
  const total = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total ${FROM} ${where}`,
    values,
  );

  return toPaged(rows.map(mapOpportunity), total?.total ?? 0, { limit, offset });
}

export async function getOpportunity(idOrSalesforceId: string): Promise<Opportunity> {
  const row = await findOpportunity(idOrSalesforceId);
  if (!row) throw notFound('opportunity', idOrSalesforceId);
  return mapOpportunity(row);
}

async function findOpportunity(idOrId: string): Promise<OpportunityRow | null> {
  const kind = classifyId(idOrId);
  if (kind === 'uuid') {
    return queryOne<OpportunityRow>(`SELECT ${SELECT_COLUMNS} ${FROM} WHERE o.id = $1`, [idOrId]);
  }
  if (kind === 'salesforce') {
    return queryOne<OpportunityRow>(`SELECT ${SELECT_COLUMNS} ${FROM} WHERE o.salesforce_id = $1`, [
      idOrId,
    ]);
  }
  return null;
}

export async function createOpportunity(input: CreateOpportunityInput): Promise<Opportunity> {
  const data = validate(createOpportunitySchema, input);
  const accountId = await resolveAccountId(data.account_id);

  let id: string | undefined;
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO opportunities
         (name, account_id, stage, amount, close_date, owner_name, probability, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'local') RETURNING id`,
      [
        data.name,
        accountId,
        data.stage === undefined ? 'Prospecting' : requireStage(data.stage),
        data.amount === undefined ? '0.00' : toAmount(data.amount),
        data.close_date ?? null,
        cleanText(data.owner_name),
        data.probability ?? null,
      ],
    );
    id = row?.id;
  } catch (error) {
    translateWriteError(error);
  }
  if (!id) throw new Error('failed to insert opportunity');
  return getOpportunity(id);
}

export async function updateOpportunity(
  id: string,
  input: UpdateOpportunityInput,
): Promise<Opportunity> {
  const data = validate(updateOpportunitySchema, input);
  const kind = classifyId(id);
  if (kind === 'unknown') throw notFound('opportunity', id);

  const accountId =
    data.account_id === undefined ? undefined : await resolveAccountId(data.account_id);

  const statement = buildUpdate({
    table: 'opportunities o',
    patch: {
      name: data.name,
      account_id: accountId,
      stage: data.stage === undefined ? undefined : requireStage(data.stage),
      amount: data.amount === undefined ? undefined : toAmount(data.amount),
      close_date: data.close_date === undefined ? undefined : data.close_date,
      owner_name: data.owner_name === undefined ? undefined : cleanText(data.owner_name),
      probability: data.probability === undefined ? undefined : data.probability,
    },
    key: { column: kind === 'uuid' ? 'o.id' : 'o.salesforce_id', value: id },
    returning: 'o.id',
  });

  if (!statement) return getOpportunity(id);

  let updatedId: string | undefined;
  try {
    const row = await queryOne<{ id: string }>(statement.text, statement.values);
    updatedId = row?.id;
  } catch (error) {
    translateWriteError(error);
  }
  if (!updatedId) throw notFound('opportunity', id);
  return getOpportunity(updatedId);
}
