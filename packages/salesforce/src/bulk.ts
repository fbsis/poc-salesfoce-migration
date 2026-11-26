/**
 * Bulk API 2.0 **query** jobs (`docs/CONTRACTS.md` §6, "Bulk query jobs (corrected)").
 *
 * Flow per object — the real Salesforce contract, not an ingest-shaped fake:
 *   1. POST  /services/data/:v/jobs/query   { operation:'query', query: SOQL, contentType:'CSV' }
 *      → the job returns `UploadComplete`; the SOQL travels in the *create* body.
 *   2. (no batch upload: `PUT …/batches` is ingest-only and a query job takes no data)
 *   3. GET   /services/data/:v/jobs/query/:id          poll until `JobComplete`
 *   4. GET   /services/data/:v/jobs/query/:id/results  CSV of the selected columns,
 *      paged via the `Sforce-Query-Locator` response header + `?locator=`.
 *
 * Results contain **only** the queried columns (plus `Id` when it was selected) —
 * there is no `sf__Id`/`sf__Created` bookkeeping. `SystemModstamp` and friends are
 * passed through exactly as returned.
 *
 * Then `applySalesforceBatch` from `@poc/core` upserts the records. Core owns
 * the unique key (`salesforce_id`), so running this twice is a no-op on row
 * count — that is the idempotency guarantee, not something this module adds.
 */
import {
  applySalesforceBatch,
  finishSyncRun,
  startSyncRun,
  type SalesforceRecord,
} from '@poc/core';

import { SalesforceApiError, dataPath, sfJson, sfRequest } from './http';
import { parseCsv, rowsToRecords } from './csv';
import {
  OBJECT_NAMES,
  buildSoql,
  isSalesforceObjectName,
  type SalesforceObjectName,
} from './objects';

export interface BulkJobStatus {
  id: string;
  object?: string;
  operation?: string;
  state: string;
  numberRecordsProcessed?: number;
  numberRecordsFailed?: number;
  retries?: number;
  totalProcessingTime?: number;
  errorMessage?: string | null;
}

export interface ExtractedObject {
  object: SalesforceObjectName;
  records: SalesforceRecord[];
  raw: string;
}

export interface BulkObjectResult {
  object: SalesforceObjectName;
  read: number;
  applied: number;
  skipped_stale: number;
  ignored: number;
  errors: Array<{ id: string; message: string }>;
  durationMs: number;
}

export interface BulkExtractSummary {
  syncRunId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  objects: BulkObjectResult[];
  totals: {
    read: number;
    applied: number;
    skipped_stale: number;
    ignored: number;
    errors: number;
  };
}

export interface BulkExtractOptions {
  objects?: readonly SalesforceObjectName[];
  fields?: Partial<Record<SalesforceObjectName, readonly string[]>>;
  /** Structured log sink. Defaults to console. */
  log?: (line: string) => void;
  poll?: { initialDelayMs?: number; maxDelayMs?: number; timeoutMs?: number };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const DEFAULT_POLL = { initialDelayMs: 200, maxDelayMs: 2_000, timeoutMs: 120_000 };

/** Safety stop for the result-page loop (real jobs page far below this). */
const MAX_RESULT_PAGES = 10_000;

const QUERY_JOB_PATH = 'jobs/query';

function jobStateIsTerminalFailure(state: string): boolean {
  return state === 'Failed' || state === 'Aborted' || state === 'JobFailed';
}

/**
 * Create a Bulk API 2.0 **query** job: the SOQL is the body of the create call.
 * There is no batch upload — the job is `UploadComplete` when it comes back.
 */
export async function createQueryJob(
  object: SalesforceObjectName,
  soql: string,
): Promise<string> {
  const created = await sfJson<BulkJobStatus>('POST', dataPath(QUERY_JOB_PATH), {
    contentType: 'application/json',
    body: JSON.stringify({
      operation: 'query',
      query: soql,
      contentType: 'CSV',
      columnDelimiter: ',',
      lineEnding: 'LF',
    }),
  });
  if (!created?.id) throw new Error(`Bulk query job creation returned no id for ${object}`);
  return created.id;
}

/** Poll a query job until it completes. Backoff 200ms → 2s, hard cap ~2 minutes. */
export async function waitForJob(
  jobId: string,
  poll: BulkExtractOptions['poll'] = {},
): Promise<BulkJobStatus> {
  const initial = poll?.initialDelayMs ?? DEFAULT_POLL.initialDelayMs;
  const max = poll?.maxDelayMs ?? DEFAULT_POLL.maxDelayMs;
  const timeout = poll?.timeoutMs ?? DEFAULT_POLL.timeoutMs;

  const startedAt = Date.now();
  let delay = initial;
  for (;;) {
    const status = await sfJson<BulkJobStatus>('GET', dataPath(`${QUERY_JOB_PATH}/${jobId}`));
    if (status.state === 'JobComplete') return status;
    if (jobStateIsTerminalFailure(status.state)) {
      throw new Error(
        `Bulk query job ${jobId} ended in state ${status.state}` +
          (status.errorMessage ? `: ${status.errorMessage}` : ''),
      );
    }
    if (Date.now() - startedAt > timeout) {
      throw new Error(
        `Bulk query job ${jobId} did not complete within ${timeout}ms (last state ${status.state})`,
      );
    }
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.8), max);
  }
}

/**
 * Download every page of a completed job's `results` and concatenate them.
 *
 * Each page is CSV with the same header; the next page is requested with the
 * opaque `Sforce-Query-Locator` value and paging stops when the header is
 * `null` (or absent). `raw` is the concatenation of the pages as returned.
 */
export async function downloadResults(
  jobId: string,
): Promise<{ raw: string; records: SalesforceRecord[]; pages: number }> {
  const rawPages: string[] = [];
  const rows: Array<Record<string, string>> = [];
  let locator: string | null = null;
  let pages = 0;

  for (;;) {
    if (pages >= MAX_RESULT_PAGES) {
      throw new Error(`Bulk query job ${jobId} returned more than ${MAX_RESULT_PAGES} pages`);
    }
    const suffix = locator
      ? `${QUERY_JOB_PATH}/${jobId}/results?locator=${encodeURIComponent(locator)}`
      : `${QUERY_JOB_PATH}/${jobId}/results`;
    const response = await sfRequest('GET', dataPath(suffix), { accept: 'text/csv' });
    const text = await response.text();
    pages += 1;
    if (!response.ok) {
      throw new SalesforceApiError(
        `Salesforce GET ${suffix} → ${response.status}: ${text.slice(0, 300)}`,
        response.status,
        `HTTP_${response.status}`,
        text.slice(0, 300),
      );
    }
    rawPages.push(text);
    rows.push(...parseCsv(text).rows);

    const next = response.headers.get('sforce-query-locator');
    if (!next || next === 'null' || next.trim() === '') break;
    locator = next.trim();
  }

  return { raw: rawPages.join(''), records: rowsToRecords(rows), pages };
}

/** Run one Bulk API 2.0 query job for `objectName` and return its records. */
export async function extractObject(
  objectName: string,
  fields?: readonly string[],
): Promise<ExtractedObject> {
  if (!isSalesforceObjectName(objectName)) {
    throw new Error(`Unsupported Salesforce object: ${objectName}`);
  }
  const soql = buildSoql(objectName, fields);
  const jobId = await createQueryJob(objectName, soql);
  await waitForJob(jobId);
  const { raw, records } = await downloadResults(jobId);
  return { object: objectName, records, raw };
}

function asLog(options: BulkExtractOptions): (line: string) => void {
  return options.log ?? ((line: string) => console.log(line));
}

/**
 * Full extraction: Account → Contact → Opportunity → Lead, one sync run.
 * Idempotent — a second run leaves row counts unchanged (core upserts by
 * `salesforce_id` and the stale-write guard accepts equal timestamps).
 */
export async function runBulkExtract(
  options: BulkExtractOptions = {},
): Promise<BulkExtractSummary> {
  const log = asLog(options);
  const objects = (options.objects?.length ? options.objects : OBJECT_NAMES).filter(
    isSalesforceObjectName,
  );
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const syncRunId = await startSyncRun('bulk_extract', {
    source: 'bulk_api_2_0',
    objects,
    mode: process.env.SF_USE_MOCK === 'false' ? 'real' : 'mock',
  });

  const results: BulkObjectResult[] = [];
  let failure: string | null = null;

  try {
    for (const object of objects) {
      const objectStarted = Date.now();
      try {
        const extracted = await extractObject(object, options.fields?.[object]);
        const applied = await applySalesforceBatch(object, 'CREATE', extracted.records);
        const entry: BulkObjectResult = {
          object,
          read: extracted.records.length,
          applied: applied.applied,
          skipped_stale: applied.skipped_stale,
          ignored: applied.ignored,
          errors: applied.errors,
          durationMs: Date.now() - objectStarted,
        };
        results.push(entry);
        log(
          `[bulk] ${object} read=${entry.read} applied=${entry.applied} ` +
            `skipped_stale=${entry.skipped_stale} ignored=${entry.ignored} ` +
            `errors=${entry.errors.length} ms=${entry.durationMs}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failure = failure ?? `${object}: ${message}`;
        results.push({
          object,
          read: 0,
          applied: 0,
          skipped_stale: 0,
          ignored: 0,
          errors: [{ id: object, message }],
          durationMs: Date.now() - objectStarted,
        });
        log(`[bulk] ${object} FAILED ${message}`);
      }
    }
  } finally {
    const totals = results.reduce(
      (accumulator, entry) => ({
        read: accumulator.read + entry.read,
        applied: accumulator.applied + entry.applied,
        skipped_stale: accumulator.skipped_stale + entry.skipped_stale,
        ignored: accumulator.ignored + entry.ignored,
        errors: accumulator.errors + entry.errors.length,
      }),
      { read: 0, applied: 0, skipped_stale: 0, ignored: 0, errors: 0 },
    );

    const finishedAtMs = Date.now();
    await finishSyncRun(syncRunId, {
      status: failure ? 'failed' : 'success',
      records_read: totals.read,
      records_written: totals.applied,
      ...(failure ? { error: failure } : {}),
      details: {
        source: 'bulk_api_2_0',
        duration_ms: finishedAtMs - startedAtMs,
        objects: results,
        totals,
      },
    });

    return {
      syncRunId,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      objects: results,
      totals,
    };
  }
}
