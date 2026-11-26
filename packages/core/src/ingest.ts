/**
 * Salesforce ingestion — the single place where the stale-write rule lives
 * (docs/CONTRACTS.md §3).
 *
 * Guarantees:
 *  - upsert by `salesforce_id`, idempotent (replaying the same record is a no-op
 *    on content, and an equal timestamp still writes);
 *  - never regress a row, without exceptions: the incoming `SystemModstamp`
 *    (fallback `LastModifiedDate`, then the CDC
 *    `ChangeEventHeader.commitTimestamp`) is compared to the stored
 *    `salesforce_updated_at` **in SQL**, so concurrent workers cannot overwrite
 *    newer data with an older snapshot;
 *  - **a record with no usable timestamp may only INSERT.** Because a
 *    timestamp-less snapshot cannot be proven newer, it never updates an
 *    existing row: that write is rejected as `ignored` with
 *    `reason: 'missing timestamp'` (a first insert with no timestamp is still
 *    accepted, and its `salesforce_updated_at` stays NULL);
 *  - DELETE honours the same rule when the caller passes the event timestamp:
 *    `deleteSalesforceRecord(object, id, { updatedAt })` only removes a row
 *    whose `salesforce_updated_at` is NULL or not newer than the event, and
 *    reports `skipped_stale` otherwise. Without the option the delete is
 *    unconditional (legacy two-argument call);
 *  - a Contact/Opportunity whose parent Account is not known locally is stored
 *    with `account_id = NULL` (never fails) and re-linked by
 *    `linkOrphanRecords()` — after every batch **and** after every applied
 *    Account upsert, so the CDC path does not leave orphans behind;
 *  - **unmappable non-null values are never dropped silently.** A non-null
 *    `StageName` outside the internal enum, or a non-null `Amount` that is not
 *    a finite number in `[0, 1e12)`, throws a `validationError` naming the
 *    field and value instead of migrating a row with a default/absent value.
 *    `applySalesforceBatch` captures that in `errors[]` and writes nothing for
 *    the record (explicit `null`/absent fields remain "not carried", not an
 *    error).
 */
import { query, queryOne, withTransaction } from './db';
import { validationError } from './errors';
import { cleanText } from './sql';
import type { ChangeType, LeadStatus, OpportunityStage } from './types';
import { CHANGE_TYPES, OPPORTUNITY_STAGES } from './types';

export interface SalesforceRecord {
  Id: string;
  [field: string]: unknown;
}

export interface ApplyResult {
  outcome: 'applied' | 'skipped_stale' | 'ignored';
  entity: 'account' | 'contact' | 'opportunity' | 'lead' | 'unknown';
  id: string | null; // local id when applied
  reason?: string;
}

export type IngestEntity = 'account' | 'contact' | 'opportunity' | 'lead';

type Entity = IngestEntity | 'unknown';

const TABLES: Record<IngestEntity, string> = {
  account: 'accounts',
  contact: 'contacts',
  opportunity: 'opportunities',
  lead: 'leads',
};

/** Object names arrive as `Account`, `account`, `AccountChangeEvent`, … */
export function normaliseObject(objectName: string): Entity {
  if (typeof objectName !== 'string') return 'unknown';
  const raw = objectName
    .trim()
    .replace(/ChangeEvent$/i, '')
    .replace(/__c$/i, '')
    .toLowerCase();
  switch (raw) {
    case 'account':
    case 'accounts':
      return 'account';
    case 'contact':
    case 'contacts':
      return 'contact';
    case 'opportunity':
    case 'opportunities':
      return 'opportunity';
    case 'lead':
    case 'leads':
      return 'lead';
    default:
      return 'unknown';
  }
}

// ------------------------------------------------------------ field helpers

interface FieldValue {
  present: boolean;
  value: unknown;
}

function pick(record: SalesforceRecord, ...keys: string[]): FieldValue {
  const source = record as Record<string, unknown>;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    return { present: true, value: value === '' ? null : value };
  }
  return { present: false, value: null };
}

function readOwner(record: SalesforceRecord): FieldValue {
  const direct = pick(record, 'Owner.Name', 'OwnerName');
  if (direct.present) return direct;
  const owner = (record as Record<string, unknown>).Owner;
  if (owner && typeof owner === 'object') {
    const name = (owner as Record<string, unknown>).Name;
    if (name !== undefined) return { present: true, value: name === '' ? null : name };
  }
  // Fall back to the raw owner id when no name is available.
  return pick(record, 'OwnerId');
}

function setText(
  target: Record<string, unknown>,
  column: string,
  fieldValue: FieldValue,
  options?: { lower?: boolean },
): void {
  if (!fieldValue.present) return;
  const value = fieldValue.value === null ? null : String(fieldValue.value);
  const cleaned = cleanText(value);
  target[column] = options?.lower ? (cleaned === null ? null : cleaned.toLowerCase()) : cleaned;
}

function setNumber(target: Record<string, unknown>, column: string, fieldValue: FieldValue): void {
  if (!fieldValue.present) return;
  if (fieldValue.value === null) {
    target[column] = null;
    return;
  }
  const parsed = Number(fieldValue.value);
  if (!Number.isFinite(parsed)) return;
  target[column] = parsed;
}

/** Salesforce timestamps: ISO strings, `+0000` offsets, or epoch seconds/ms. */
export function parseSalesforceTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') {
    const ms = Math.abs(value) < 1e12 ? value * 1000 : value;
    const parsed = new Date(ms);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const raw = String(value).trim();
  if (raw === '') return null;
  if (/^-?\d+$/.test(raw)) return parseSalesforceTimestamp(Number(raw));
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function recordTimestamp(record: SalesforceRecord): string | null {
  const direct = pick(record, 'SystemModstamp', 'LastModifiedDate', 'systemModstamp');
  if (direct.present) {
    const parsed = parseSalesforceTimestamp(direct.value);
    if (parsed) return parsed;
  }
  const header = (record as Record<string, unknown>).ChangeEventHeader;
  if (header && typeof header === 'object') {
    const parsed = parseSalesforceTimestamp((header as Record<string, unknown>).commitTimestamp);
    if (parsed) return parsed;
  }
  return null;
}

function toDateOnly(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function mapStage(value: unknown): OpportunityStage | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  const exact = OPPORTUNITY_STAGES.find((stage) => stage.toLowerCase() === raw.toLowerCase());
  return exact ?? null;
}

/** Map the many Salesforce lead statuses onto the four internal ones. */
function mapLeadStatus(value: unknown): LeadStatus | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().toLowerCase();
  if (raw === '') return null;
  if (raw === 'new' || raw === 'contacted' || raw === 'qualified' || raw === 'closed') {
    return raw as LeadStatus;
  }
  // Salesforce defaults look like "Open - Not Contacted" / "Working - Contacted" /
  // "Closed - Converted"; check the negative forms before the positive ones.
  if (/not\s*contacted|uncontacted|^open/.test(raw)) return 'new';
  if (/closed|converted|lost|unqualified/.test(raw)) return 'closed';
  if (/qualif/.test(raw)) return 'qualified';
  if (/contact|working|nurtur/.test(raw)) return 'contacted';
  if (/new|open/.test(raw)) return 'new';
  return null;
}

// ------------------------------------------------------------- record maps

function mapAccountColumns(record: SalesforceRecord): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  setText(columns, 'name', pick(record, 'Name'));
  setText(columns, 'industry', pick(record, 'Industry'));
  setText(columns, 'website', pick(record, 'Website'));
  setText(columns, 'billing_country', pick(record, 'BillingCountry'));
  setText(columns, 'owner_name', readOwner(record));
  // `name` is NOT NULL: a null (or absent) name must not blank the column.
  if (columns.name === null) delete columns.name;
  return columns;
}

function mapContactColumns(record: SalesforceRecord): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  setText(columns, 'first_name', pick(record, 'FirstName'));
  setText(columns, 'last_name', pick(record, 'LastName'));
  setText(columns, 'email', pick(record, 'Email'), { lower: true });
  setText(columns, 'phone', pick(record, 'Phone'));
  setText(columns, 'title', pick(record, 'Title'));
  return columns;
}

function mapOpportunityColumns(record: SalesforceRecord): Record<string, unknown> {
  const columns: Record<string, unknown> = {};

  setText(columns, 'name', pick(record, 'Name'));
  if (columns.name === null) delete columns.name;

  const stage = pick(record, 'StageName');
  if (stage.present && stage.value !== null) {
    const mapped = mapStage(stage.value);
    if (!mapped) {
      // Never drop a non-null enum silently: the row would migrate with the
      // column default (see the module docs).
      const value = String(stage.value);
      throw validationError(`unmapped StageName: "${value}"`, {
        field: 'StageName',
        value,
        expected: OPPORTUNITY_STAGES,
      });
    }
    columns.stage = mapped;
  }

  const amount = pick(record, 'Amount');
  if (amount.present && amount.value !== null) {
    const parsed = Number(amount.value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 1e12) {
      const value = String(amount.value);
      throw validationError(`invalid Amount: "${value}"`, {
        field: 'Amount',
        value,
        expected: 'a finite number >= 0 and < 1e12',
      });
    }
    columns.amount = parsed.toFixed(2);
  }

  const closeDate = pick(record, 'CloseDate');
  if (closeDate.present) columns.close_date = toDateOnly(closeDate.value);

  setText(columns, 'owner_name', readOwner(record));

  const probability = pick(record, 'Probability');
  if (probability.present) {
    if (probability.value === null) {
      columns.probability = null;
    } else {
      const parsed = Number(probability.value);
      if (Number.isFinite(parsed)) {
        columns.probability = Math.min(100, Math.max(0, Math.round(parsed)));
      }
    }
  }

  return columns;
}

function mapLeadColumns(record: SalesforceRecord): Record<string, unknown> {
  const columns: Record<string, unknown> = {};

  const first = pick(record, 'FirstName');
  const last = pick(record, 'LastName');
  if (first.present || last.present) {
    const joined = [first.value, last.value]
      .map((value) => (value === null || value === undefined ? '' : String(value).trim()))
      .filter((value) => value !== '')
      .join(' ');
    if (joined !== '') columns.full_name = joined;
  }

  setText(columns, 'email', pick(record, 'Email'), { lower: true });
  if (columns.email === null) delete columns.email; // NOT NULL

  setText(columns, 'phone', pick(record, 'Phone'));
  setText(columns, 'company', pick(record, 'Company'));
  setText(columns, 'property_interest', pick(record, 'Property_Interest__c', 'PropertyInterest'));
  setText(columns, 'message', pick(record, 'Description'));

  const status = pick(record, 'Status');
  if (status.present) {
    const mapped = mapLeadStatus(status.value);
    if (mapped) columns.status = mapped;
  }

  return columns;
}

// ------------------------------------------------------- orphan re-linking
//
// A Contact/Opportunity can arrive before its parent Account. We cannot store
// the pending Salesforce account id on the row itself (the schema has no such
// column and db/migrations is owned by the lead agent), so the pending link is
// kept in a small side table that this module creates on demand. The migration
// that would replace it is described in the core agent's report:
//   ALTER TABLE contacts      ADD COLUMN account_salesforce_id text;
//   ALTER TABLE opportunities ADD COLUMN account_salesforce_id text;

const ORPHAN_DDL_LOCK = 872_341_234;

let orphanTableReady: Promise<void> | null = null;

async function ensureOrphanTable(): Promise<void> {
  if (!orphanTableReady) {
    orphanTableReady = (async () => {
      await withTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [ORPHAN_DDL_LOCK]);
        await client.query(`CREATE TABLE IF NOT EXISTS sf_orphan_links (
          entity                text NOT NULL,
          local_id              uuid NOT NULL,
          account_salesforce_id text NOT NULL,
          created_at            timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (entity, local_id)
        )`);
        await client.query(
          `CREATE INDEX IF NOT EXISTS sf_orphan_links_account_idx
             ON sf_orphan_links (account_salesforce_id)`,
        );
      });
    })().catch((error: unknown) => {
      orphanTableReady = null;
      throw error;
    });
  }
  return orphanTableReady;
}

async function rememberOrphanLink(
  entity: 'contact' | 'opportunity',
  localId: string,
  accountSalesforceId: string,
): Promise<void> {
  await ensureOrphanTable();
  await query(
    `INSERT INTO sf_orphan_links (entity, local_id, account_salesforce_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (entity, local_id)
     DO UPDATE SET account_salesforce_id = EXCLUDED.account_salesforce_id`,
    [entity, localId, accountSalesforceId],
  );
}

/**
 * Fix `account_id` on Contacts/Opportunities whose parent Account exists now,
 * by joining the pending Salesforce account ids against `accounts.salesforce_id`.
 * Also prunes links whose row already has an account or no longer exists.
 */
export async function linkOrphanRecords(): Promise<{ contacts: number; opportunities: number }> {
  await ensureOrphanTable();

  const contacts = await query<{ local_id: string }>(
    `WITH resolved AS (
       UPDATE contacts c SET account_id = a.id
         FROM sf_orphan_links l
         JOIN accounts a ON a.salesforce_id = l.account_salesforce_id
        WHERE l.entity = 'contact' AND l.local_id = c.id AND c.account_id IS NULL
       RETURNING c.id
     )
     DELETE FROM sf_orphan_links
      WHERE entity = 'contact' AND local_id IN (SELECT id FROM resolved)
     RETURNING local_id`,
  );

  const opportunities = await query<{ local_id: string }>(
    `WITH resolved AS (
       UPDATE opportunities o SET account_id = a.id
         FROM sf_orphan_links l
         JOIN accounts a ON a.salesforce_id = l.account_salesforce_id
        WHERE l.entity = 'opportunity' AND l.local_id = o.id AND o.account_id IS NULL
       RETURNING o.id
     )
     DELETE FROM sf_orphan_links
      WHERE entity = 'opportunity' AND local_id IN (SELECT id FROM resolved)
     RETURNING local_id`,
  );

  await query(
    `DELETE FROM sf_orphan_links l
      WHERE (l.entity = 'contact'
             AND (NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = l.local_id)
                  OR EXISTS (SELECT 1 FROM contacts c WHERE c.id = l.local_id AND c.account_id IS NOT NULL)))
         OR (l.entity = 'opportunity'
             AND (NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.id = l.local_id)
                  OR EXISTS (SELECT 1 FROM opportunities o WHERE o.id = l.local_id AND o.account_id IS NOT NULL)))`,
  );

  return { contacts: contacts.length, opportunities: opportunities.length };
}

// ------------------------------------------------------------------ upsert

interface UpsertArgs {
  entity: IngestEntity;
  salesforceId: string;
  columns: Record<string, unknown>;
  fallback?: Record<string, unknown>;
  updatedAt: string | null;
}

interface UpsertOutcome {
  id: string | null;
  /** Why the conflict guard refused the write, when it did. */
  rejected: 'stale' | 'missing_timestamp' | null;
}

function buildUpsert({ entity, salesforceId, columns, fallback, updatedAt }: UpsertArgs): {
  text: string;
  values: unknown[];
} {
  const data: Record<string, unknown> = { ...columns };
  for (const [column, value] of Object.entries(fallback ?? {})) {
    if (!(column in data)) data[column] = value;
  }

  const table = TABLES[entity];
  const dataColumns = Object.keys(data);
  const insertColumns = [...dataColumns, 'salesforce_id', 'source', 'salesforce_updated_at'];
  const values: unknown[] = [
    ...dataColumns.map((column) => data[column] ?? null),
    salesforceId,
    'salesforce',
    updatedAt,
  ];

  const placeholders = insertColumns.map((column, index) =>
    column === 'salesforce_updated_at' ? `$${index + 1}::timestamptz` : `$${index + 1}`,
  );

  const assignments = dataColumns.map((column) => `${column} = EXCLUDED.${column}`);
  // The guard below guarantees EXCLUDED.salesforce_updated_at is non-null on
  // every conflict path, so the stamp can never be "kept" from a newer row.
  assignments.push(`salesforce_updated_at = EXCLUDED.salesforce_updated_at`);
  assignments.push(`source = 'salesforce'`);
  assignments.push('synced_at = now()');

  // The stale-write guard lives here, in SQL: >= so an idempotent replay at an
  // equal timestamp still writes. A record with no timestamp can only INSERT —
  // it must never overwrite an existing row it cannot prove is older.
  const guard = `EXCLUDED.salesforce_updated_at IS NOT NULL
      AND EXCLUDED.salesforce_updated_at >= COALESCE(${table}.salesforce_updated_at, 'epoch'::timestamptz)`;

  return {
    text: `INSERT INTO ${table} (${insertColumns.join(', ')}, synced_at)
            VALUES (${placeholders.join(', ')}, now())
            ON CONFLICT (salesforce_id) DO UPDATE SET ${assignments.join(', ')}
            WHERE ${guard}
            RETURNING id`,
    values,
  };
}

async function upsertSalesforceRow(args: UpsertArgs): Promise<UpsertOutcome> {
  const statement = buildUpsert(args);
  const row = await queryOne<{ id: string }>(statement.text, statement.values);
  if (row) return { id: row.id, rejected: null };

  // No row returned: the conflict guard rejected the write. Distinguish a stale
  // skip from a missing-timestamp rejection and from an unexpected no-op.
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM ${TABLES[args.entity]} WHERE salesforce_id = $1`,
    [args.salesforceId],
  );
  if (!existing) return { id: null, rejected: null };
  return { id: null, rejected: args.updatedAt === null ? 'missing_timestamp' : 'stale' };
}

async function resolveParentAccount(
  record: SalesforceRecord,
): Promise<{ present: boolean; accountId: string | null; salesforceAccountId: string | null }> {
  const fieldValue = pick(record, 'AccountId');
  if (!fieldValue.present) {
    return { present: false, accountId: null, salesforceAccountId: null };
  }
  const salesforceAccountId =
    fieldValue.value === null ? null : String(fieldValue.value).trim() || null;
  if (!salesforceAccountId) {
    return { present: true, accountId: null, salesforceAccountId: null };
  }
  const row = await queryOne<{ id: string }>('SELECT id FROM accounts WHERE salesforce_id = $1', [
    salesforceAccountId,
  ]);
  return { present: true, accountId: row?.id ?? null, salesforceAccountId };
}

/**
 * Upsert one Salesforce record. Idempotent by `salesforce_id`; never overwrites
 * a newer row.
 */
export async function applySalesforceRecord(
  objectName: string,
  changeType: ChangeType,
  record: SalesforceRecord,
): Promise<ApplyResult> {
  const entity = normaliseObject(objectName);
  if (entity === 'unknown') {
    return {
      outcome: 'ignored',
      entity: 'unknown',
      id: null,
      reason: `unsupported object: ${String(objectName)}`,
    };
  }
  if (!CHANGE_TYPES.includes(changeType)) {
    throw validationError(`unsupported change type: ${String(changeType)}`, {
      changeType: 'invalid',
    });
  }

  const salesforceId = cleanText(
    typeof record?.Id === 'string' ? record.Id : record?.Id == null ? null : String(record.Id),
  );
  if (!salesforceId) {
    return { outcome: 'ignored', entity, id: null, reason: 'record has no Id' };
  }

  const updatedAt = recordTimestamp(record);

  if (changeType === 'DELETE') {
    // Forward the event timestamp so the delete is guarded too (null = no guard).
    return deleteSalesforceRecord(objectName, salesforceId, { updatedAt });
  }

  // CREATE / UPDATE / UNDELETE all upsert.
  let columns: Record<string, unknown>;
  let fallback: Record<string, unknown> | undefined;
  let orphan: { entity: 'contact' | 'opportunity'; accountSalesforceId: string } | null = null;

  if (entity === 'account') {
    columns = mapAccountColumns(record);
    fallback = { name: salesforceId };
  } else if (entity === 'opportunity') {
    columns = mapOpportunityColumns(record);
    fallback = { name: salesforceId };
  } else if (entity === 'lead') {
    columns = mapLeadColumns(record);
    fallback = { full_name: salesforceId, email: '' };
  } else {
    columns = mapContactColumns(record);
  }

  if (entity === 'contact' || entity === 'opportunity') {
    const parent = await resolveParentAccount(record);
    if (parent.accountId) {
      columns.account_id = parent.accountId;
    } else if (parent.present && !parent.salesforceAccountId) {
      // Explicitly cleared in Salesforce.
      columns.account_id = null;
    } else if (parent.present && parent.salesforceAccountId) {
      // Unknown locally: insert with NULL and remember the pending link.
      orphan = { entity, accountSalesforceId: parent.salesforceAccountId };
    }
  }

  const outcome = await upsertSalesforceRow({ entity, salesforceId, columns, fallback, updatedAt });
  if (!outcome.id) {
    if (outcome.rejected === 'missing_timestamp') {
      return { outcome: 'ignored', entity, id: null, reason: 'missing timestamp' };
    }
    if (outcome.rejected === 'stale') {
      return {
        outcome: 'skipped_stale',
        entity,
        id: null,
        reason: 'incoming record is older than the stored salesforce_updated_at',
      };
    }
    return { outcome: 'ignored', entity, id: null, reason: 'no row written' };
  }

  if (orphan) await rememberOrphanLink(orphan.entity, outcome.id, orphan.accountSalesforceId);

  // CDC has no cross-topic ordering: a Contact/Opportunity can be applied
  // before its Account. Re-link right after an Account lands so the CDC path
  // does not wait for the next bulk extract.
  if (entity === 'account') {
    try {
      await linkOrphanRecords();
    } catch (error) {
      // Re-linking is best-effort: it must never fail the record write.
      console.error('[ingest] linkOrphanRecords failed after account upsert', error);
    }
  }

  return { outcome: 'applied', entity, id: outcome.id };
}

/** Bulk upsert. One statement per record; per-outcome counts and per-record errors. */
export async function applySalesforceBatch(
  objectName: string,
  changeType: ChangeType,
  records: SalesforceRecord[],
): Promise<{
  applied: number;
  skipped_stale: number;
  ignored: number;
  errors: Array<{ id: string; message: string }>;
}> {
  const totals = { applied: 0, skipped_stale: 0, ignored: 0, errors: [] as Array<{ id: string; message: string }> };

  for (const record of records ?? []) {
    const recordId = record && record.Id != null ? String(record.Id) : '';
    try {
      const result = await applySalesforceRecord(objectName, changeType, record);
      if (result.outcome === 'applied') totals.applied += 1;
      else if (result.outcome === 'skipped_stale') totals.skipped_stale += 1;
      else totals.ignored += 1;
    } catch (error) {
      totals.errors.push({
        id: recordId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Re-link contacts/opportunities whose parent Account arrived in this batch.
  try {
    await linkOrphanRecords();
  } catch (error) {
    console.error('[ingest] linkOrphanRecords failed', error);
  }

  return totals;
}

export interface DeleteSalesforceOptions {
  /**
   * The DELETE event's timestamp. When it parses, the delete is guarded: a row
   * whose `salesforce_updated_at` is newer is kept and the call reports
   * `skipped_stale`. `null`/absent = unguarded (legacy behaviour).
   */
  updatedAt?: string | null;
}

/**
 * Hard delete by `salesforce_id`. Used for CDC DELETE events.
 *
 * With `options.updatedAt` the timestamp comparison lives in the DELETE's
 * `WHERE`, so a replayed or out-of-order DELETE cannot remove a newer row.
 */
export async function deleteSalesforceRecord(
  objectName: string,
  salesforceId: string,
  options: DeleteSalesforceOptions = {},
): Promise<ApplyResult> {
  const entity = normaliseObject(objectName);
  if (entity === 'unknown') {
    return {
      outcome: 'ignored',
      entity: 'unknown',
      id: null,
      reason: `unsupported object: ${String(objectName)}`,
    };
  }
  const id = cleanText(salesforceId);
  if (!id) return { outcome: 'ignored', entity, id: null, reason: 'missing salesforce id' };

  const table = TABLES[entity];
  const guardedAt = parseSalesforceTimestamp(options.updatedAt);

  const row = guardedAt
    ? await queryOne<{ id: string }>(
        `DELETE FROM ${table}
          WHERE salesforce_id = $1
            AND (salesforce_updated_at IS NULL OR salesforce_updated_at <= $2::timestamptz)
          RETURNING id`,
        [id, guardedAt],
      )
    : await queryOne<{ id: string }>(`DELETE FROM ${table} WHERE salesforce_id = $1 RETURNING id`, [
        id,
      ]);
  if (row) return { outcome: 'applied', entity, id: row.id, reason: 'deleted' };

  if (guardedAt) {
    // No row deleted: either the row is newer than the event, or there is none.
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM ${table} WHERE salesforce_id = $1`,
      [id],
    );
    if (existing) {
      return {
        outcome: 'skipped_stale',
        entity,
        id: null,
        reason: 'delete older than local row',
      };
    }
  }

  return { outcome: 'ignored', entity, id: null, reason: 'no local row for salesforce id' };
}
