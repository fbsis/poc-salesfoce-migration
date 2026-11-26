/**
 * REST surface of the mock Salesforce org (port 4000).
 *
 *  POST /services/oauth2/token                     client_credentials → mock token
 *  POST /services/data/:version/jobs/query         Bulk API 2.0 **query** job (create, SOQL in the body)
 *  GET  /services/data/:version/jobs/query/:id     job status (poll)
 *  GET  /services/data/:version/jobs/query/:id/results   CSV of the selected columns, paged
 *  GET  /services/data/:version/query?q=SELECT+…   synchronous SOQL
 *  /mock/{health,state,seed,reset,emit,disconnect,config}  admin (no auth, demo only)
 *
 * Bulk API 2.0 query-job detail (the real contract — see docs/CONTRACTS.md §6
 * "Bulk query jobs (corrected)"):
 *  - the SOQL is supplied **when the job is created**; a query job takes no
 *    batch upload, so `PUT …/jobs/ingest/:id/batches` is not part of this flow;
 *  - the job is `UploadComplete` immediately, then `InProgress`, then
 *    `JobComplete` (state is advanced lazily from the job's age, one 300 ms tick);
 *  - `results` is CSV whose header is exactly the SELECT list (no `sf__Id`,
 *    no `sf__Created`), and a zero-row query still returns the header row;
 *  - results are paged: 2000 rows per page, the next page's token is returned in
 *    the `Sforce-Query-Locator` response header and echoed back as `?locator=`;
 *    the last page sends `Sforce-Query-Locator: null`.
 *
 * Bulk **ingest** jobs (data upload) are not implemented: this mock only does
 * query jobs, so `/services/data/:version/jobs/ingest…` answers 404.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { z } from 'zod';

import { sfId } from './seed';
import {
  CHANGE_TYPES,
  DEFAULT_COMMIT_USER,
  encodeReplayId,
  isChangeType,
  isSfObject,
  parseSfDate,
  toSfDateTime,
  toObjectName,
  type DatasetInput,
  type SfObject,
  type SfRecord,
  type SalesforceStore,
} from './store';
import type { PubSubControl } from './grpc';

const API_VERSION = process.env.SF_API_VERSION ?? 'v62.0';
const ACCESS_TOKEN = process.env.SF_MOCK_ACCESS_TOKEN ?? 'mock-access-token';
const CONFIGURED_INSTANCE_URL = process.env.SF_INSTANCE_URL ?? '';

const DATE_FIELDS = new Set(['SystemModstamp', 'LastModifiedDate', 'CreatedDate', 'CloseDate']);

// --------------------------------------------------------------- CSV helpers

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : String(value);
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(',');
}

/** Parses a single CSV/TSV row (quotes, escaped quotes, delimiter). */
export function parseCsvLine(line: string, delimiter = ','): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

// -------------------------------------------------------------- SOQL parsing

interface SoqlQuery {
  object: SfObject;
  fields: string[];
  where: string | null;
  limit: number | null;
}

interface FilterClause {
  field: string;
  operator: '>=' | '<=' | '!=' | '=' | '>' | '<' | 'in' | 'like';
  values: string[];
}

export function parseSoql(soql: string, options: { injectId?: boolean } = {}): SoqlQuery {
  const text = soql.trim().replace(/;$/, '');
  const match = /^select\s+([\s\S]+?)\s+from\s+([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/i.exec(text);
  if (!match) throw new Error(`Invalid SOQL: ${soql}`);
  const object = toObjectName(match[2]);
  if (!object) throw new Error(`Unsupported SOQL object: ${match[2]}`);
  const fields = match[1]
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean)
    .map((field) => {
      // strip a trailing alias: `Owner.Name ownerName`
      const alias = /^([\w.]+)\s+[\w]+$/.exec(field);
      return alias ? alias[1] : field;
    });
  if (fields.length === 0) throw new Error(`Invalid SOQL (no fields): ${soql}`);
  // The synchronous `/query` endpoint always needs an id (`attributes.url`); a
  // Bulk **query job** must return exactly the columns the caller selected, so
  // it passes `injectId: false`.
  if (options.injectId !== false) ensureIdField(fields);
  const tail = match[3] ?? '';
  const whereMatch = /\bwhere\b([\s\S]*?)(?:\border\s+by\b|\blimit\b|$)/i.exec(tail);
  const limitMatch = /\blimit\s+(\d+)/i.exec(tail);
  return {
    object,
    fields,
    where: whereMatch ? whereMatch[1].trim() : null,
    limit: limitMatch ? Number(limitMatch[1]) : null,
  };
}

/** Salesforce always needs a record id; inject it when the caller omitted it. */
function ensureIdField(fields: string[]): string[] {
  if (!fields.some((field) => field.toLowerCase() === 'id')) fields.unshift('Id');
  return fields;
}

function parseWhere(where: string | null): FilterClause[] {
  if (!where) return [];
  const clauses: FilterClause[] = [];
  const parts = where.split(/\s+and\s+/i);
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    const inMatch = /^([A-Za-z_][\w.]*)\s+in\s*\(([\s\S]*)\)$/i.exec(part);
    if (inMatch) {
      const values = splitList(inMatch[2]).map(unquote);
      clauses.push({ field: inMatch[1], operator: 'in', values });
      continue;
    }
    const likeMatch = /^([A-Za-z_][\w.]*)\s+like\s+'([\s\S]*)'$/i.exec(part);
    if (likeMatch) {
      clauses.push({ field: likeMatch[1], operator: 'like', values: [likeMatch[2]] });
      continue;
    }
    const compare = /^([A-Za-z_][\w.]*)\s*(>=|<=|!=|<>|=|>|<)\s*(.+)$/.exec(part);
    if (compare) {
      const operator = compare[2] === '<>' ? '!=' : (compare[2] as FilterClause['operator']);
      clauses.push({ field: compare[1], operator, values: [unquote(compare[3].trim())] });
      continue;
    }
    console.warn(`[salesforce-mock] ignoring unsupported SOQL predicate: ${part}`);
  }
  return clauses;
}

function splitList(text: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of text) {
    if (char === "'") inQuotes = !inQuotes;
    if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') values.push(current.trim());
  return values;
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

// ------------------------------------------------------------- field access

function resolveField(record: SfRecord, field: string): unknown {
  if (Object.prototype.hasOwnProperty.call(record, field)) return record[field];
  if (field === 'Owner' || field === 'Owner.Name') return record.OwnerName ?? null;
  if (field.includes('.')) {
    let current: unknown = record;
    for (const part of field.split('.')) {
      if (current === null || current === undefined || typeof current !== 'object') return null;
      current = (current as Record<string, unknown>)[part];
    }
    return current ?? null;
  }
  return null;
}

function toComparable(value: unknown, field: string): string | number | boolean | null {
  if (value === null || value === undefined || value === '') return null;
  if (DATE_FIELDS.has(field)) {
    const ms = parseSfDate(value);
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value;
  const text = String(value);
  if (text === 'true') return true;
  if (text === 'false') return false;
  const num = Number(text);
  if (text !== '' && Number.isFinite(num) && field !== 'Id') return num;
  return text;
}

function matchesClause(record: SfRecord, clause: FilterClause): boolean {
  const actualRaw = resolveField(record, clause.field);
  if (clause.operator === 'in') {
    const actual = toComparable(actualRaw, clause.field);
    return clause.values.some((value) => {
      const expected = DATE_FIELDS.has(clause.field)
        ? toComparable(value, clause.field)
        : unquote(value);
      return actual !== null && String(actual) === String(expected);
    });
  }
  if (clause.operator === 'like') {
    const actual = String(actualRaw ?? '').toLowerCase();
    const pattern = clause.values[0].toLowerCase().replace(/%/g, '.*').replace(/_/g, '.');
    return new RegExp(`^${pattern}$`).test(actual);
  }
  const actual = toComparable(actualRaw, clause.field);
  const expected = toComparable(clause.values[0], clause.field);
  if (actual === null || expected === null) return false;
  switch (clause.operator) {
    case '=':
      return String(actual) === String(expected);
    case '!=':
      return String(actual) !== String(expected);
    case '>':
      return actual > expected;
    case '<':
      return actual < expected;
    case '>=':
      return actual >= expected;
    case '<=':
      return actual <= expected;
    default:
      return false;
  }
}

function mentionsIsDeleted(where: string | null): boolean {
  return !!where && /\bIsDeleted\b/i.test(where);
}

function selectRecords(
  store: SalesforceStore,
  object: SfObject,
  where: string | null,
  limit: number | null,
): SfRecord[] {
  const clauses = parseWhere(where);
  const includeDeleted = mentionsIsDeleted(where);
  let rows = store
    .list(object)
    .filter((record) => (includeDeleted ? true : record.IsDeleted !== true))
    .filter((record) => clauses.every((clause) => matchesClause(record, clause)));
  rows = rows.sort((left, right) => {
    const leftStamp = parseSfDate(left.SystemModstamp);
    const rightStamp = parseSfDate(right.SystemModstamp);
    const delta = (Number.isNaN(leftStamp) ? 0 : leftStamp) - (Number.isNaN(rightStamp) ? 0 : rightStamp);
    if (delta !== 0) return delta;
    return String(left.Id).localeCompare(String(right.Id));
  });
  if (limit !== null) rows = rows.slice(0, limit);
  return rows;
}

interface ProjectedRecord {
  attributes: { type: string; url: string };
  [field: string]: unknown;
}

function projectRecord(
  record: SfRecord,
  object: SfObject,
  fields: string[],
  version: string,
): ProjectedRecord {
  const projected: ProjectedRecord = {
    attributes: {
      type: object,
      url: `/services/data/${version}/sobjects/${object}/${String(record.Id)}`,
    },
  };
  for (const field of fields) {
    const value = resolveField(record, field);
    if (field.includes('.')) {
      const [head, ...rest] = field.split('.');
      const key = rest.join('.');
      const relatedId =
        head === 'Owner' && typeof record.OwnerId === 'string' ? record.OwnerId : String(record.Id);
      const existing =
        projected[head] && typeof projected[head] === 'object'
          ? (projected[head] as Record<string, unknown>)
          : {
              attributes: {
                type: head,
                url: `/services/data/${version}/sobjects/${head}/${relatedId}`,
              },
            };
      existing[key] = value;
      projected[head] = existing;
    } else {
      projected[field] = value;
    }
  }
  return projected;
}

function csvValue(value: unknown): unknown {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value;
}

// ------------------------------------------------ bulk API 2.0 query jobs

/** Bulk API 2.0 query-job states (a query job never sits in `Open`). */
type QueryJobState = 'UploadComplete' | 'InProgress' | 'JobComplete' | 'Failed' | 'Aborted';

/** Rows per `results` page, before `Sforce-Query-Locator` paging kicks in. */
export const MAX_RESULT_PAGE_SIZE = 2000;

/** A freshly created query job is `UploadComplete`; it then advances on its own. */
const JOB_IN_PROGRESS_AFTER_MS = 50;
const JOB_COMPLETE_AFTER_MS = 300;

interface QueryJob {
  id: string;
  object: SfObject;
  operation: 'query';
  state: QueryJobState;
  contentType: string;
  columnDelimiter: string;
  lineEnding: string;
  soql: string;
  /** Exactly the SELECT list — the results CSV header, nothing else. */
  fields: string[];
  where: string | null;
  limit: number | null;
  records: SfRecord[];
  numberRecordsProcessed: number;
  numberRecordsFailed: number;
  errorMessage: string | null;
  createdDate: string;
  systemModstamp: string;
  createdAtMs: number;
  totalProcessingTime: number;
}

function jobSummary(job: QueryJob): Record<string, unknown> {
  return {
    id: job.id,
    object: job.object,
    operation: job.operation,
    state: job.state,
    contentType: job.contentType,
    apiVersion: API_VERSION,
    createdById: DEFAULT_COMMIT_USER,
    createdDate: job.createdDate,
    systemModstamp: job.systemModstamp,
    jobType: 'V2Query',
    concurrencyMode: 'Parallel',
    columnDelimiter: job.columnDelimiter,
    lineEnding: job.lineEnding,
    numberRecordsProcessed: job.numberRecordsProcessed,
    numberRecordsFailed: job.numberRecordsFailed,
    retries: 0,
    totalProcessingTime: job.totalProcessingTime,
    apiActiveProcessingTime: job.totalProcessingTime,
    apexProcessingTime: 0,
    errorMessage: job.errorMessage,
  };
}

/** `,` | `|` | `;` | `^` | `\t` — the names (`COMMA`, `TAB`, …) are accepted too. */
function delimiterFor(value: string): string {
  const named: Record<string, string> = {
    COMMA: ',',
    PIPE: '|',
    SEMICOLON: ';',
    CARET: '^',
    TAB: '\t',
  };
  const trimmed = value.trim();
  return named[trimmed.toUpperCase()] ?? (trimmed === '' ? ',' : trimmed);
}

function lineEndingFor(value: string): string {
  return value.trim().toUpperCase() === 'CRLF' ? '\r\n' : '\n';
}

/** Result pages are addressed by an opaque `Sforce-Query-Locator` token. */
function encodeLocator(offset: number): string {
  return Buffer.from(`locator:${offset}`, 'utf8').toString('base64url');
}

function decodeLocator(value: string): number | null {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const match = /^locator:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Advance the job's state machine from its age and, on completion, snapshot the
 * query result. Idempotent — every read path calls it before answering.
 */
function advanceJob(store: SalesforceStore, job: QueryJob): void {
  if (job.state === 'JobComplete' || job.state === 'Failed' || job.state === 'Aborted') return;
  const elapsed = Date.now() - job.createdAtMs;
  if (elapsed < JOB_IN_PROGRESS_AFTER_MS) {
    job.state = 'UploadComplete';
    return;
  }
  if (elapsed < JOB_COMPLETE_AFTER_MS) {
    job.state = 'InProgress';
    return;
  }
  try {
    job.records = selectRecords(store, job.object, job.where, job.limit);
    job.numberRecordsProcessed = job.records.length;
    job.numberRecordsFailed = 0;
    job.state = 'JobComplete';
  } catch (error) {
    job.state = 'Failed';
    job.errorMessage = error instanceof Error ? error.message : String(error);
  }
  job.totalProcessingTime = elapsed;
  job.systemModstamp = toSfDateTime(new Date());
}

function instanceUrl(req: Request): string {
  if (CONFIGURED_INSTANCE_URL) return CONFIGURED_INSTANCE_URL;
  return `${req.protocol}://${req.get('host') ?? 'localhost:4000'}`;
}

const salesforceError = (message: string, errorCode: string) => [{ message, errorCode }];

const seedBodySchema = z
  .object({
    accounts: z.array(z.record(z.unknown())).optional(),
    contacts: z.array(z.record(z.unknown())).optional(),
    opportunities: z.array(z.record(z.unknown())).optional(),
    leads: z.array(z.record(z.unknown())).optional(),
    /** `replace` (default) makes the seeded dataset a snapshot; `merge` adds. */
    mode: z.enum(['replace', 'merge']).optional(),
  })
  .passthrough();

const emitBodySchema = z
  .object({
    object: z.string(),
    changeType: z.string(),
    record: z.record(z.unknown()),
    changedFields: z.array(z.string()).optional(),
    commitUser: z.string().optional(),
  })
  .passthrough();

const disconnectBodySchema = z
  .object({
    topic: z.string().optional(),
  })
  .passthrough();

const configBodySchema = z
  .object({
    queryJobPageSize: z.number().int().min(1).max(MAX_RESULT_PAGE_SIZE).optional(),
  })
  .passthrough();

export interface RestAppOptions {
  store: SalesforceStore;
  pubsub: PubSubControl;
}

export function createRestApp(options: RestAppOptions): Express {
  const { store, pubsub } = options;
  const app = express();
  const jobs = new Map<string, QueryJob>();
  let jobCounter = 0;
  // Rows per `results` page. Real Bulk 2.0 pages well below its 2000-row cap;
  // the mock pages at exactly 2000 so the client's locator loop is exercised,
  // and `/mock/config` can lower it to prove multi-page concatenation.
  const configuredPageSize = Number(process.env.SF_MOCK_QUERY_PAGE_SIZE ?? NaN);
  let queryJobPageSize =
    Number.isFinite(configuredPageSize) && configuredPageSize > 0
      ? Math.min(Math.floor(configuredPageSize), MAX_RESULT_PAGE_SIZE)
      : MAX_RESULT_PAGE_SIZE;

  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true }));

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const header = String(req.headers.authorization ?? '');
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (token !== ACCESS_TOKEN) {
      res.status(401).json(salesforceError('Session expired or invalid', 'INVALID_SESSION_ID'));
      return;
    }
    next();
  };

  // ------------------------------------------------------------ mock admin

  const health = (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      dataset: store.counts(),
      subscribers: pubsub.subscriberCount(),
      subscribersByTopic: {
        '/data/AccountChangeEvent': pubsub.subscriberCount('/data/AccountChangeEvent'),
        '/data/ContactChangeEvent': pubsub.subscriberCount('/data/ContactChangeEvent'),
        '/data/OpportunityChangeEvent': pubsub.subscriberCount('/data/OpportunityChangeEvent'),
        '/data/LeadChangeEvent': pubsub.subscriberCount('/data/LeadChangeEvent'),
      },
      latestReplayId: store.latestReplayId,
      latestCommitNumber: store.latestCommitNumber,
      queryJobPageSize,
      uptimeSeconds: Math.round(process.uptime()),
    });
  };
  app.get('/mock/health', health);
  app.get('/health', health);

  app.get('/mock/config', (_req: Request, res: Response) => {
    res.json({ queryJobPageSize });
  });

  /** Test hook: shrink the query-result page size so paging is observable. */
  app.post('/mock/config', (req: Request, res: Response) => {
    const parsed = configBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(salesforceError(parsed.error.message, 'INVALID_INPUT'));
      return;
    }
    if (parsed.data.queryJobPageSize !== undefined) {
      queryJobPageSize = parsed.data.queryJobPageSize;
    }
    res.json({ ok: true, queryJobPageSize });
  });

  app.post('/mock/seed', (req: Request, res: Response) => {
    const parsed = seedBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(salesforceError(parsed.error.message, 'INVALID_INPUT'));
      return;
    }
    const body = parsed.data;
    const mode = body.mode ?? 'replace';
    const input: DatasetInput = {
      Account: body.accounts as SfRecord[] | undefined,
      Contact: body.contacts as SfRecord[] | undefined,
      Opportunity: body.opportunities as SfRecord[] | undefined,
      Lead: body.leads as SfRecord[] | undefined,
    };
    // `replace` (the default) is the deterministic demo/test reset: the store
    // holds exactly the supplied rows afterwards. `merge` keeps the current
    // rows and upserts the supplied ones, for callers that add to a dataset.
    const counts = mode === 'merge' ? store.mergeAll(input) : store.replaceAll(input);
    res.json({ ok: true, mode, counts });
  });

  app.get('/mock/state', (_req: Request, res: Response) => {
    const snapshot = store.snapshot();
    res.json({
      dataset: snapshot.data,
      counts: snapshot.counts,
      events: store.allEvents(),
      latestReplayId: store.latestReplayId,
      latestCommitNumber: store.latestCommitNumber,
      oldestBufferedReplayId: store.oldestReplayId,
    });
  });

  app.post('/mock/reset', (_req: Request, res: Response) => {
    store.clear();
    pubsub.reset();
    res.json({ ok: true, counts: store.counts(), events: 0 });
  });

  app.post('/mock/emit', (req: Request, res: Response) => {
    const parsed = emitBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(salesforceError(parsed.error.message, 'INVALID_INPUT'));
      return;
    }
    const body = parsed.data;
    const object = toObjectName(body.object);
    if (!object || !isSfObject(object)) {
      res
        .status(400)
        .json(salesforceError(`Unsupported object: ${body.object}`, 'INVALID_INPUT'));
      return;
    }
    if (!isChangeType(body.changeType)) {
      res
        .status(400)
        .json(
          salesforceError(
            `Unsupported changeType: ${body.changeType} (expected ${CHANGE_TYPES.join('|')})`,
            'INVALID_INPUT',
          ),
        );
      return;
    }
    try {
      const result = store.emit({
        object,
        changeType: body.changeType,
        record: body.record as SfRecord,
        changedFields: body.changedFields,
        commitUser: body.commitUser,
      });
      res.json({
        ok: true,
        object,
        changeType: body.changeType,
        topic: result.event.topic,
        replayId: result.event.replayId,
        replayIdHex: encodeReplayId(result.event.replayId).toString('hex'),
        commitNumber: result.event.commitNumber,
        commitTimestamp: result.event.commitTimestamp,
        sequenceNumber: result.event.sequenceNumber,
        changedFields: result.event.changedFields,
        nulledFields: result.event.nulledFields,
        delivered: result.delivered,
        queued: result.queued,
      });
    } catch (error) {
      res
        .status(400)
        .json(
          salesforceError(error instanceof Error ? error.message : String(error), 'INVALID_INPUT'),
        );
    }
  });

  app.post('/mock/disconnect', (req: Request, res: Response) => {
    const parsed = disconnectBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(salesforceError(parsed.error.message, 'INVALID_INPUT'));
      return;
    }
    const disconnected = pubsub.disconnect(parsed.data.topic);
    res.json({ ok: true, disconnected, subscribers: pubsub.subscriberCount() });
  });

  // ------------------------------------------------------------- OAuth token

  app.post('/services/oauth2/token', (req: Request, res: Response) => {
    const grantType = String(req.body?.grant_type ?? 'client_credentials');
    if (!['client_credentials', 'password'].includes(grantType)) {
      res.status(400).json({ error: 'unsupported_grant_type', error_description: grantType });
      return;
    }
    res.json({
      access_token: ACCESS_TOKEN,
      instance_url: instanceUrl(req),
      token_type: 'Bearer',
      scope: 'api',
      issued_at: String(Date.now()),
      signature: 'mock-signature',
    });
  });

  app.use('/services', requireAuth);

  app.get('/services/data', (_req: Request, res: Response) => {
    res.json([{ label: 'Winter 25', url: `/services/data/${API_VERSION}`, version: '62.0' }]);
  });

  app.get('/services/data/:version', (req: Request, res: Response) => {
    res.json({
      label: 'Winter 25',
      version: '62.0',
      encoding: 'UTF-8',
      sobjects: `/services/data/${req.params.version}/sobjects`,
    });
  });

  // ------------------------------------------------- Bulk API 2.0 query jobs

  /**
   * Create a query job. The SOQL arrives **in the create body** — this is the
   * whole difference from an ingest job: there is no batch upload afterwards,
   * and the job is `UploadComplete` as soon as it exists.
   */
  app.post('/services/data/:version/jobs/query', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const operation = String(body.operation ?? 'query');
    if (operation !== 'query') {
      res.status(400).json(salesforceError(`Unsupported operation: ${operation}`, 'INVALIDJOB'));
      return;
    }
    const soql = typeof body.query === 'string' ? body.query.trim() : '';
    if (!soql) {
      res
        .status(400)
        .json(salesforceError('A query job requires a `query` (SOQL) property', 'MALFORMED_QUERY'));
      return;
    }
    let parsed: SoqlQuery;
    try {
      // No id injection: the results header is exactly the SELECT list.
      parsed = parseSoql(soql, { injectId: false });
    } catch (error) {
      res
        .status(400)
        .json(
          salesforceError(
            error instanceof Error ? error.message : String(error),
            'MALFORMED_QUERY',
          ),
        );
      return;
    }
    const now = new Date();
    const job: QueryJob = {
      id: sfId('750', ++jobCounter),
      object: parsed.object,
      operation: 'query',
      state: 'UploadComplete',
      contentType: String(body.contentType ?? 'CSV'),
      columnDelimiter: String(body.columnDelimiter ?? ','),
      lineEnding: String(body.lineEnding ?? 'LF'),
      soql,
      fields: parsed.fields,
      where: parsed.where,
      limit: parsed.limit,
      records: [],
      numberRecordsProcessed: 0,
      numberRecordsFailed: 0,
      errorMessage: null,
      createdDate: toSfDateTime(now),
      systemModstamp: toSfDateTime(now),
      createdAtMs: now.getTime(),
      totalProcessingTime: 0,
    };
    jobs.set(job.id, job);
    res
      .status(200)
      .location(`/services/data/${req.params.version}/jobs/query/${job.id}`)
      .json(jobSummary(job));
  });

  app.get('/services/data/:version/jobs/query/:id', (req: Request, res: Response) => {
    const job = jobs.get(String(req.params.id));
    if (!job) {
      res.status(404).json(salesforceError('The requested resource does not exist', 'NOT_FOUND'));
      return;
    }
    advanceJob(store, job);
    res.json(jobSummary(job));
  });

  /**
   * One page of results: CSV whose header is exactly the SELECT list (no
   * `sf__Id`, no `sf__Created`), zero rows still yields the header row, and the
   * next page's token travels in `Sforce-Query-Locator` (`null` when done).
   */
  app.get('/services/data/:version/jobs/query/:id/results', (req: Request, res: Response) => {
    const job = jobs.get(String(req.params.id));
    if (!job) {
      res.status(404).json(salesforceError('The requested resource does not exist', 'NOT_FOUND'));
      return;
    }
    advanceJob(store, job);
    if (job.state !== 'JobComplete') {
      res
        .status(400)
        .json(salesforceError(`Job is not complete (state=${job.state})`, 'INVALIDJOBSTATE'));
      return;
    }

    const rawLocator = typeof req.query.locator === 'string' ? req.query.locator : null;
    const start = rawLocator ? decodeLocator(rawLocator) : 0;
    if (start === null) {
      res
        .status(400)
        .json(salesforceError(`Invalid locator: ${rawLocator}`, 'INVALID_PARAMETER'));
      return;
    }
    const page = job.records.slice(start, start + queryJobPageSize);
    const nextOffset = start + page.length;
    const locator = nextOffset < job.records.length ? encodeLocator(nextOffset) : null;

    const delimiter = delimiterFor(job.columnDelimiter);
    const eol = lineEndingFor(job.lineEnding);
    const lines = [job.fields.map((field) => csvEscape(field)).join(delimiter)];
    for (const record of page) {
      lines.push(
        job.fields
          .map((field) => csvEscape(csvValue(resolveField(record, field))))
          .join(delimiter),
      );
    }

    res.setHeader('Content-Type', `text/csv; charset=utf-8`);
    res.setHeader('Sforce-Query-Locator', locator ?? 'null');
    res.setHeader('Sforce-NumberOfRecords', String(page.length));
    res.setHeader('Access-Control-Expose-Headers', 'Sforce-Query-Locator, Sforce-NumberOfRecords');
    res.status(200).send(`${lines.join(eol)}${eol}`);
  });

  // Retired: the mock used to fake query jobs with the *ingest* shape (SOQL
  // PUT as a "batch", PATCH UploadComplete, successfulResults with
  // sf__Id/sf__Created). That flow never existed in Salesforce, so it is gone:
  // ingest jobs are out of scope for this mock and the query-job batch upload
  // answers 404 rather than silently accepting the wrong shape.
  const retiredBulkPath = (req: Request, res: Response): void => {
    res
      .status(404)
      .json(
        salesforceError(
          `Not implemented by the mock: ${req.method} ${req.originalUrl} ` +
            '(this mock serves Bulk API 2.0 query jobs only; a query job takes the SOQL in the create body and no batch upload)',
          'NOT_FOUND',
        ),
      );
  };
  app.use('/services/data/:version/jobs/ingest', retiredBulkPath);
  app.use('/services/data/:version/jobs/query/:id/batches', retiredBulkPath);

  // ------------------------------------------------------------- SOQL query

  app.get('/services/data/:version/query', (req: Request, res: Response) => {
    const soql = typeof req.query.q === 'string' ? req.query.q : '';
    if (!soql) {
      res
        .status(400)
        .json(salesforceError('A SOQL query must be provided in the q parameter', 'MALFORMED_QUERY'));
      return;
    }
    try {
      const version = String(req.params.version ?? API_VERSION);
      const parsed = parseSoql(soql);
      const records = selectRecords(store, parsed.object, parsed.where, parsed.limit).map(
        (record) => projectRecord(record, parsed.object, parsed.fields, version),
      );
      res.json({ totalSize: records.length, done: true, records });
    } catch (error) {
      res
        .status(400)
        .json(
          salesforceError(
            error instanceof Error ? error.message : String(error),
            'MALFORMED_QUERY',
          ),
        );
    }
  });

  // -------------------------------------------------------------- fallbacks

  app.use((_req: Request, res: Response) => {
    res.status(404).json(salesforceError('The requested resource does not exist', 'NOT_FOUND'));
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[salesforce-mock] request failed: ${message}`);
    res.status(500).json(salesforceError(message, 'UNKNOWN_EXCEPTION'));
  });

  return app;
}
