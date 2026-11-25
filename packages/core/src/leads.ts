/**
 * Lead service — see docs/CONTRACTS.md §3/§5.
 * Emails are always stored lower-cased; `consent_at` is stamped when consent is
 * given.
 */
import { query, queryOne } from './db';
import { notFound, validationError } from './errors';
import { classifyId } from './ids';
import { DEFAULT_SEARCH_LIMIT, normalizeLimit, normalizePagination, toPaged } from './pagination';
import { mapLead, type LeadRow } from './rows';
import { buildUpdate, cleanEmail, cleanText, createConditions, searchTerm } from './sql';
import type {
  CreateLeadInput,
  Lead,
  LeadSource,
  LeadStatus,
  ListLeadsParams,
  Paged,
  UpdateLeadInput,
} from './types';
import {
  createLeadSchema,
  leadSourceSchema,
  leadStatusSchema,
  updateLeadSchema,
  updateLeadStatusSchema,
  validate,
} from './validation';

const COLUMNS = `l.id, l.salesforce_id, l.full_name, l.email, l.phone, l.company,
  l.property_interest, l.message, l.status, l.source, l.consent, l.consent_at,
  l.salesforce_updated_at, l.synced_at, l.created_at, l.updated_at`;

const RETURNING = COLUMNS.split(',')
  .map((column) => column.trim().replace(/^l\./, ''))
  .join(', ');

function requireStatus(status: LeadStatus): LeadStatus {
  const parsed = leadStatusSchema.safeParse(status);
  if (!parsed.success) {
    throw validationError('status is not a valid lead status', { status: 'invalid status' });
  }
  return parsed.data;
}

function requireSource(source: LeadSource): LeadSource {
  const parsed = leadSourceSchema.safeParse(source);
  if (!parsed.success) {
    throw validationError('source is not a valid lead source', { source: 'invalid source' });
  }
  return parsed.data;
}

function requireTimestamp(value: string, field: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw validationError(`${field} must be an ISO timestamp`, { [field]: 'invalid timestamp' });
  }
  return new Date(value).toISOString();
}

export async function listLeads(params: ListLeadsParams = {}): Promise<Paged<Lead>> {
  const { limit, offset } = normalizePagination(params);
  const conditions = createConditions();

  const search = searchTerm(params.search);
  if (search) {
    const placeholder = conditions.param(`%${search}%`);
    conditions.add(
      `(l.full_name ILIKE ${placeholder} OR l.email ILIKE ${placeholder}
        OR COALESCE(l.company, '') ILIKE ${placeholder}
        OR COALESCE(l.property_interest, '') ILIKE ${placeholder})`,
    );
  }
  if (params.status !== undefined && params.status !== null) {
    conditions.add(`l.status = ${conditions.param(requireStatus(params.status))}`);
  }
  if (params.source !== undefined && params.source !== null) {
    conditions.add(`l.source = ${conditions.param(requireSource(params.source))}`);
  }
  if (params.created_since) {
    conditions.add(`l.created_at >= ${conditions.param(requireTimestamp(params.created_since, 'created_since'))}`);
  }

  const where = conditions.where();
  const values = conditions.values;

  const rows = await query<LeadRow>(
    `SELECT ${COLUMNS} FROM leads l ${where}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );
  const total = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM leads l ${where}`,
    values,
  );

  return toPaged(rows.map(mapLead), total?.total ?? 0, { limit, offset });
}

export async function getLead(idOrSalesforceId: string): Promise<Lead> {
  const row = await findLead(idOrSalesforceId);
  if (!row) throw notFound('lead', idOrSalesforceId);
  return mapLead(row);
}

async function findLead(idOrId: string): Promise<LeadRow | null> {
  const kind = classifyId(idOrId);
  if (kind === 'uuid') {
    return queryOne<LeadRow>(`SELECT ${COLUMNS} FROM leads l WHERE l.id = $1`, [idOrId]);
  }
  if (kind === 'salesforce') {
    return queryOne<LeadRow>(`SELECT ${COLUMNS} FROM leads l WHERE l.salesforce_id = $1`, [idOrId]);
  }
  return null;
}

export async function getLeadByEmail(email: string): Promise<Lead | null> {
  const normalised = cleanEmail(email);
  if (!normalised) return null;
  const row = await queryOne<LeadRow>(
    `SELECT ${COLUMNS} FROM leads l WHERE lower(l.email) = $1
      ORDER BY l.created_at DESC, l.id DESC LIMIT 1`,
    [normalised],
  );
  return row ? mapLead(row) : null;
}

export async function searchLeads(term: string, limit?: number): Promise<Lead[]> {
  const search = searchTerm(term);
  if (!search) return [];
  const capped = normalizeLimit(limit, DEFAULT_SEARCH_LIMIT);
  const rows = await query<LeadRow>(
    `SELECT ${COLUMNS} FROM leads l
      WHERE l.full_name ILIKE $1
         OR l.email ILIKE $1
         OR COALESCE(l.company, '') ILIKE $1
      ORDER BY l.created_at DESC, l.id DESC LIMIT $2`,
    [`%${search}%`, capped],
  );
  return rows.map(mapLead);
}

export async function createLead(input: CreateLeadInput): Promise<Lead> {
  const data = validate(createLeadSchema, input);
  const email = cleanEmail(data.email);
  if (!email) {
    throw validationError('email is required', { email: 'email is required' });
  }
  const consent = data.consent === true;

  const row = await queryOne<LeadRow>(
    `INSERT INTO leads
       (full_name, email, phone, company, property_interest, message, status, source, consent, consent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             CASE WHEN $9::boolean THEN now() ELSE NULL END)
     RETURNING ${RETURNING}`,
    [
      data.full_name.trim(),
      email,
      cleanText(data.phone),
      cleanText(data.company),
      cleanText(data.property_interest),
      cleanText(data.message),
      data.status ? requireStatus(data.status) : 'new',
      data.source ? requireSource(data.source) : 'landing_page',
      consent,
    ],
  );
  if (!row) throw new Error('failed to insert lead');
  return mapLead(row);
}

export async function updateLeadStatus(id: string, status: LeadStatus): Promise<Lead> {
  const data = validate(updateLeadStatusSchema, { status });
  return updateLead(id, { status: data.status });
}

export async function updateLead(id: string, input: UpdateLeadInput): Promise<Lead> {
  const data = validate(updateLeadSchema, input);
  const kind = classifyId(id);
  if (kind === 'unknown') throw notFound('lead', id);

  const email = data.email === undefined ? undefined : cleanEmail(data.email);
  if (data.email !== undefined && !email) {
    throw validationError('email is required', { email: 'email is required' });
  }

  const statement = buildUpdate({
    table: 'leads l',
    patch: {
      full_name: data.full_name === undefined ? undefined : data.full_name.trim(),
      email,
      phone: data.phone === undefined ? undefined : cleanText(data.phone),
      company: data.company === undefined ? undefined : cleanText(data.company),
      property_interest:
        data.property_interest === undefined ? undefined : cleanText(data.property_interest),
      message: data.message === undefined ? undefined : cleanText(data.message),
      status: data.status === undefined ? undefined : requireStatus(data.status),
    },
    key: { column: kind === 'uuid' ? 'l.id' : 'l.salesforce_id', value: id },
    returning: RETURNING,
  });

  if (!statement) return getLead(id);

  const row = await queryOne<LeadRow>(statement.text, statement.values);
  if (!row) throw notFound('lead', id);
  return mapLead(row);
}
