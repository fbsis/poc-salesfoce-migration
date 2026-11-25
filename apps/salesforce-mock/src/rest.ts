/**
 * REST surface of the mock Salesforce org (port 4000).
 *
 *  POST /services/oauth2/token                          client_credentials → mock token
 *  POST /services/data/:version/jobs/ingest             Bulk API 2.0 query job (create)
 *  PUT  /services/data/:version/jobs/ingest/:id/batches upload SOQL (or a CSV header row)
 *  PATCH/services/data/:version/jobs/ingest/:id         { state: 'UploadComplete' }
 *  GET  /services/data/:version/jobs/ingest/:id         job status
 *  GET  /services/data/:version/jobs/ingest/:id/successfulResults
 *  GET  /services/data/:version/jobs/ingest/:id/failedResults
 *  GET  /services/data/:version/query?q=SELECT+…       synchronous SOQL
 *  /mock/{health,seed,state,reset,emit,disconnect}      admin (no auth, demo only)
 *
 * Bulk API 2.0 detail: successfulResults is CSV with `sf__Id` and `sf__Created`
 * first, then every queried field except `Id` (which would be redundant with
 * `sf__Id`). `failedResults` returns its header only (the mock never fails a
 * query row). Job state machine: Open → InProgress (PATCH UploadComplete) →
 * JobComplete (one 250 ms tick later).
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
  type SfObject,
  type SfRecord,
  type SalesforceStore,
} from './store';
import type { PubSubControl } from './grpc';

const API_VERSION = process.env.SF_API_VERSION ?? 'v62.0';
const ACCESS_TOKEN = process.env.SF_MOCK_ACCESS_TOKEN ?? 'mock-access-token';
const CONFIGURED_INSTANCE_URL = process.env.SF_INSTANCE_URL ?? '';
const JOB_COMPLETE_DELAY_MS = 250;

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

/** First non-empty CSV line, quote-aware (the body may have \r\n endings). */
function firstNonEmptyLine(text: string): string {
  let inQuotes = false;
  let line = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') inQuotes = !inQuotes;
    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (line.trim() !== '') return line;
      line = '';
      continue;
    }
    line += char;
  }
  return line;
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

export function parseSoql(soql: string): SoqlQuery {
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
  ensureIdField(fields);
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

// ------------------------------------------------------------- bulk API jobs

type JobState = 'Open' | 'InProgress' | 'JobComplete' | 'Failed' | 'Aborted';

interface BulkJob {
  id: string;
  object: SfObject;
  operation: 'query';
  state: JobState;
  contentType: string;
  columnDelimiter: string;
  lineEnding: string;
  soql: string | null;
  fields: string[];
  records: SfRecord[];
  numberRecordsProcessed: number;
  numberRecordsFailed: number;
  errorMessage: string | null;
  createdDate: string;
  systemModstamp: string;
  completedAt: number | null;
}

function jobSummary(job: BulkJob): Record<string, unknown> {
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
    retryCount: 0,
    totalProcessingTime: 0,
    apiActiveProcessingTime: 0,
    apexProcessingTime: 0,
    errorMessage: job.errorMessage,
  };
}

/** Extracts the SOQL text, or the field list from a CSV header row. */
function batchFieldList(body: string): { soql: string | null; fields: string[] } {
  const text = body.replace(/^\uFEFF/, '').trim();
  if (!text) return { soql: null, fields: [] };
  const unquoted =
    text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1).replace(/""/g, '"') : text;
  if (/^select\b/i.test(unquoted)) {
    const parsed = parseSoql(unquoted);
    return { soql: unquoted, fields: parsed.fields };
  }
  const header = firstNonEmptyLine(text);
  const fields = parseCsvLine(header)
    .map((field) => field.replace(/^\uFEFF/, '').trim())
    .filter(Boolean);
  ensureIdField(fields);
  return { soql: null, fields };
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

export interface RestAppOptions {
  store: SalesforceStore;
  pubsub: PubSubControl;
}

export function createRestApp(options: RestAppOptions): Express {
  const { store, pubsub } = options;
  const app = express();
  const jobs = new Map<string, BulkJob>();
  let jobCounter = 0;

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
      uptimeSeconds: Math.round(process.uptime()),
    });
  };
  app.get('/mock/health', health);
  app.get('/health', health);

  app.post('/mock/seed', (req: Request, res: Response) => {
    const parsed = seedBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(salesforceError(parsed.error.message, 'INVALID_INPUT'));
      return;
    }
    const body = parsed.data;
    const counts = store.replaceAll({
      Account: body.accounts as SfRecord[] | undefined,
      Contact: body.contacts as SfRecord[] | undefined,
      Opportunity: body.opportunities as SfRecord[] | undefined,
      Lead: body.leads as SfRecord[] | undefined,
    });
    res.json({ ok: true, counts });
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

  // ------------------------------------------------------- Bulk API 2.0 jobs

  const createJob = (req: Request, res: Response): void => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Accept the SOQL in the create body as a convenience (real Bulk 2.0 takes
    // it in the batch upload); the object is derived from the query when absent.
    const inlineSoql =
      typeof body.query === 'string'
        ? body.query
        : typeof body.soql === 'string'
          ? body.soql
          : null;
    let parsedInline: SoqlQuery | null = null;
    if (inlineSoql) {
      try {
        parsedInline = parseSoql(inlineSoql);
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
    }
    const object = toObjectName(String(body.object ?? parsedInline?.object ?? ''));
    if (!object || !isSfObject(object)) {
      res
        .status(400)
        .json(salesforceError(`Invalid object: ${String(body.object)}`, 'INVALIDJOB'));
      return;
    }
    const operation = String(body.operation ?? 'query');
    if (operation !== 'query') {
      res
        .status(400)
        .json(salesforceError(`Unsupported operation: ${operation}`, 'INVALIDJOB'));
      return;
    }
    const now = new Date();
    const job: BulkJob = {
      id: sfId('750', ++jobCounter),
      object,
      operation: 'query',
      state: 'Open',
      contentType: String(body.contentType ?? 'CSV'),
      columnDelimiter: String(body.columnDelimiter ?? 'COMMA'),
      lineEnding: String(body.lineEnding ?? 'LF'),
      soql: inlineSoql,
      fields: parsedInline?.fields ?? [],
      records: [],
      numberRecordsProcessed: 0,
      numberRecordsFailed: 0,
      errorMessage: null,
      createdDate: toSfDateTime(now),
      systemModstamp: toSfDateTime(now),
      completedAt: null,
    };
    jobs.set(job.id, job);
    res
      .status(201)
      .location(`/services/data/${req.params.version}/jobs/ingest/${job.id}`)
      .json(jobSummary(job));
  };

  app.post('/services/data/:version/jobs/ingest', createJob);
  app.post('/services/data/:version/jobs/query', createJob);

  const rawBody = express.raw({ type: () => true, limit: '50mb', inflate: true });

  app.put(
    '/services/data/:version/jobs/ingest/:id/batches',
    rawBody,
    (req: Request, res: Response) => {
      const job = jobs.get(String(req.params.id));
      if (!job) {
        res.status(404).json(salesforceError('The requested resource does not exist', 'NOT_FOUND'));
        return;
      }
      if (job.state !== 'Open') {
        res
          .status(400)
          .json(
            salesforceError(
              `Job is not open for uploads (state=${job.state})`,
              'INVALIDJOBSTATE',
            ),
          );
        return;
      }
      const raw = req.body;
      const text = Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : typeof raw === 'string'
          ? raw
          : JSON.stringify(raw ?? '');
      try {
        const { soql, fields } = batchFieldList(text);
        job.soql = soql;
        job.fields = fields;
        job.systemModstamp = toSfDateTime(new Date());
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
      res.status(201).json({ id: job.id, state: job.state });
    },
  );

  app.patch('/services/data/:version/jobs/ingest/:id', (req: Request, res: Response) => {
    const job = jobs.get(String(req.params.id));
    if (!job) {
      res.status(404).json(salesforceError('The requested resource does not exist', 'NOT_FOUND'));
      return;
    }
    const state = String((req.body as Record<string, unknown>)?.state ?? '');
    if (state === 'UploadComplete') {
      if (job.state === 'Open') {
        job.state = 'InProgress';
        job.systemModstamp = toSfDateTime(new Date());
        setTimeout(() => completeJob(job), JOB_COMPLETE_DELAY_MS).unref();
      }
      res.json(jobSummary(job));
      return;
    }
    if (state === 'Aborted') {
      job.state = 'Aborted';
      job.errorMessage = 'Job aborted by user';
      job.completedAt = Date.now();
      job.systemModstamp = toSfDateTime(new Date());
      res.json(jobSummary(job));
      return;
    }
    res
      .status(400)
      .json(salesforceError(`Unsupported state transition: ${state || '(empty)'}`, 'INVALIDJOB'));
  });

  app.get('/services/data/:version/jobs/ingest/:id', (req: Request, res: Response) => {
    const job = jobs.get(String(req.params.id));
    if (!job) {
      res.status(404).json(salesforceError('The requested resource does not exist', 'NOT_FOUND'));
      return;
    }
    res.json(jobSummary(job));
  });

  function completeJob(job: BulkJob): void {
    if (job.state !== 'InProgress') return;
    try {
      const parsed = job.soql ? parseSoql(job.soql) : null;
      const fields = ensureIdField([...(parsed?.fields ?? job.fields)]);
      const records = selectRecords(
        store,
        job.object,
        parsed?.where ?? null,
        parsed?.limit ?? null,
      );
      job.fields = fields;
      job.records = records;
      job.numberRecordsProcessed = records.length;
      job.numberRecordsFailed = 0;
      job.state = 'JobComplete';
      job.completedAt = Date.now();
    } catch (error) {
      job.state = 'Failed';
      job.errorMessage = error instanceof Error ? error.message : String(error);
    }
    job.systemModstamp = toSfDateTime(new Date());
  }

  function resultsCsv(job: BulkJob, withErrors: boolean): string {
    const fields = job.fields.filter((field) => field.toLowerCase() !== 'id');
    const header = withErrors
      ? ['sf__Id', 'sf__Error', ...fields]
      : ['sf__Id', 'sf__Created', ...fields];
    const lines: string[] = [csvRow(header)];
    if (withErrors) return `${lines.join('\n')}\n`;
    for (const record of job.records) {
      lines.push(
        csvRow([
          String(record.Id),
          'true',
          ...fields.map((field) => csvValue(resolveField(record, field))),
        ]),
      );
    }
    return `${lines.join('\n')}\n`;
  }

  app.get(
    '/services/data/:version/jobs/ingest/:id/successfulResults',
    (req: Request, res: Response) => {
      const job = jobs.get(String(req.params.id));
      if (!job) {
        res.status(404).json(salesforceError('The requested resource does not exist', 'NOT_FOUND'));
        return;
      }
      if (job.state !== 'JobComplete') {
        res
          .status(400)
          .json(
            salesforceError(
              `Job is not complete (state=${job.state})`,
              'INVALIDJOBSTATE',
            ),
          );
        return;
      }
      const body = resultsCsv(job, false);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Sforce-Locator', 'null');
      res.setHeader('Sforce-NumberOfRecords', String(job.records.length));
      res.status(200).send(body);
    },
  );

  app.get(
    '/services/data/:version/jobs/ingest/:id/failedResults',
    (req: Request, res: Response) => {
      const job = jobs.get(String(req.params.id));
      if (!job) {
        res.status(404).json(salesforceError('The requested resource does not exist', 'NOT_FOUND'));
        return;
      }
      if (job.state !== 'JobComplete') {
        res
          .status(400)
          .json(salesforceError(`Job is not complete (state=${job.state})`, 'INVALIDJOBSTATE'));
        return;
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Sforce-Locator', 'null');
      res.status(200).send(resultsCsv(job, true));
    },
  );

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
