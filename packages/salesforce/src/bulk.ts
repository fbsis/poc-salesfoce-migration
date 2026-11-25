/**
 * Bulk API 2.0 **query** jobs (`docs/CONTRACTS.md` §7).
 *
 * Flow per object, exactly as the mock implements it:
 *   1. POST  /services/data/:v/jobs/ingest              { object, operation:'query', contentType:'CSV' }
 *   2. PUT   /services/data/:v/jobs/ingest/:id/batches  body = SOQL text
 *   3. PATCH /services/data/:v/jobs/ingest/:id          { state:'UploadComplete' } → InProgress
 *   4. GET   /services/data/:v/jobs/ingest/:id          poll until JobComplete / JobFailed
 *   5. GET   /services/data/:v/jobs/ingest/:id/successfulResults   CSV (`sf__Id`,`sf__Created`,…)
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

import { dataPath, sfJson, sfRequest, sfText } from './http';
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

function jobStateIsTerminalFailure(state: string): boolean {
  return state === 'Failed' || state === 'Aborted' || state === 'JobFailed';
}

/** Create + upload + close a Bulk 2.0 query job. Returns the job id. */
export async function createQueryJob(
  object: SalesforceObjectName,
  soql: string,
): Promise<string> {
  const created = await sfJson<BulkJobStatus>('POST', dataPath('jobs/ingest'), {
    contentType: 'application/json',
    body: JSON.stringify({
      object,
      operation: 'query',
      contentType: 'CSV',
      columnDelimiter: 'COMMA',
      lineEnding: 'LF',
    }),
  });
  if (!created?.id) throw new Error(`Bulk job creation returned no id for ${object}`);

  const upload = await sfRequest('PUT', dataPath(`jobs/ingest/${created.id}/batches`), {
    body: soql,
    contentType: 'text/csv',
    accept: 'application/json',
  });
  if (!upload.ok) {
    const body = await upload.text().catch(() => '');
    throw new Error(`Bulk upload for ${object} failed (${upload.status}): ${body.slice(0, 300)}`);
  }

  await sfJson('PATCH', dataPath(`jobs/ingest/${created.id}`), {
    contentType: 'application/json',
    body: JSON.stringify({ state: 'UploadComplete' }),
  });
  return created.id;
}

/** Poll a job until it completes. Backoff 200ms → 2s, hard cap ~2 minutes. */
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
    const status = await sfJson<BulkJobStatus>('GET', dataPath(`jobs/ingest/${jobId}`));
    if (status.state === 'JobComplete') return status;
    if (jobStateIsTerminalFailure(status.state)) {
      throw new Error(
        `Bulk job ${jobId} ended in state ${status.state}` +
          (status.errorMessage ? `: ${status.errorMessage}` : ''),
      );
    }
    if (Date.now() - startedAt > timeout) {
      throw new Error(
        `Bulk job ${jobId} did not complete within ${timeout}ms (last state ${status.state})`,
      );
    }
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.8), max);
  }
}

/** Download + parse `successfulResults` for a completed job. */
export async function downloadResults(jobId: string): Promise<{ raw: string; records: SalesforceRecord[] }> {
  const raw = await sfText('GET', dataPath(`jobs/ingest/${jobId}/successfulResults`));
  const { rows } = parseCsv(raw);
  return { raw, records: rowsToRecords(rows) };
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
