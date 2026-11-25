/**
 * Basic reconciliation (docs/CONTRACTS.md §7.5).
 *
 * For each object, compare the Salesforce side (count + newest `SystemModstamp`
 * over SOQL) with the local side (row count + `max(salesforce_updated_at)`).
 * This is a *gap detector*, not a diff: it tells you whether a re-run of the
 * bulk extract is needed and which side is ahead.
 *
 * Local aggregates go through `@poc/core`'s exported `query` helper — no SQL is
 * duplicated from the service layer, and the worker never opens its own pool.
 */
import { finishSyncRun, parseSalesforceTimestamp, query, startSyncRun } from '@poc/core';

import { dataPath, sfJson } from './http';
import { OBJECT_NAMES, type SalesforceObjectName } from './objects';

const TABLES: Record<SalesforceObjectName, string> = {
  Account: 'accounts',
  Contact: 'contacts',
  Opportunity: 'opportunities',
  Lead: 'leads',
};

export interface ReconcileRow {
  object: SalesforceObjectName;
  salesforceCount: number;
  localCount: number;
  missingLocally: number;
  newestSalesforce: string | null;
  newestLocal: string | null;
  /** Nothing missing locally and not behind the Salesforce tip. */
  consistent: boolean;
}

export interface ReconcileReport {
  syncRunId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  rows: ReconcileRow[];
  ok: boolean;
}

interface SoqlResponse {
  totalSize: number;
  done: boolean;
  records: Array<{ Id: string; SystemModstamp?: string | null }>;
}

export interface ReconcileOptions {
  objects?: readonly SalesforceObjectName[];
  log?: (line: string) => void;
}

function newestTimestamp(values: Array<string | null | undefined>): string | null {
  let newest: number | null = null;
  let iso: string | null = null;
  for (const value of values) {
    const parsed = parseSalesforceTimestamp(value ?? null);
    if (!parsed) continue;
    const ms = Date.parse(parsed);
    if (newest === null || ms > newest) {
      newest = ms;
      iso = parsed;
    }
  }
  return iso;
}

export async function reconcileObject(object: SalesforceObjectName): Promise<ReconcileRow> {
  const soql = `SELECT Id, SystemModstamp FROM ${object}`;
  const remote = await sfJson<SoqlResponse>('GET', dataPath(`query?q=${encodeURIComponent(soql)}`));
  const remoteRecords = Array.isArray(remote?.records) ? remote.records : [];
  const salesforceCount = Number.isFinite(remote?.totalSize) ? Number(remote.totalSize) : remoteRecords.length;
  const newestSalesforce = newestTimestamp(remoteRecords.map((record) => record.SystemModstamp));

  const local = await query<{ total: number; newest: Date | string | null }>(
    `SELECT count(*)::int AS total, max(salesforce_updated_at) AS newest FROM ${TABLES[object]}`,
  );
  const localRow = local[0];
  const localCount = Number(localRow?.total ?? 0);
  const newestRaw = localRow?.newest ?? null;
  const newestLocal =
    newestRaw === null
      ? null
      : newestRaw instanceof Date
        ? newestRaw.toISOString()
        : new Date(newestRaw).toISOString();

  const missingLocally = Math.max(0, salesforceCount - localCount);
  // "Behind" is the only timestamp problem that matters: cells newer than the
  // Salesforce tip are normal (CDC applied changes after the last bulk run).
  const behind =
    newestSalesforce !== null &&
    newestLocal !== null &&
    Date.parse(newestLocal) < Date.parse(newestSalesforce) - 1_000;

  return {
    object,
    salesforceCount,
    localCount,
    missingLocally,
    newestSalesforce,
    newestLocal,
    consistent: missingLocally === 0 && !behind,
  };
}

/** Run the comparison for every object and register a `reconcile` sync run. */
export async function reconcile(options: ReconcileOptions = {}): Promise<ReconcileReport> {
  const log = options.log ?? ((line: string) => console.log(line));
  const objects = (options.objects?.length ? options.objects : OBJECT_NAMES).filter((object) =>
    (OBJECT_NAMES as readonly string[]).includes(object),
  );

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const syncRunId = await startSyncRun('reconcile', { source: 'soql', objects });

  const rows: ReconcileRow[] = [];
  let failure: string | null = null;

  try {
    for (const object of objects) {
      try {
        const row = await reconcileObject(object);
        rows.push(row);
        log(
          `[reconcile] ${row.object} salesforce=${row.salesforceCount} local=${row.localCount} ` +
            `missing=${row.missingLocally} newest_sf=${row.newestSalesforce ?? 'n/a'} ` +
            `newest_local=${row.newestLocal ?? 'n/a'} ${row.consistent ? 'consistent' : 'DRIFT'}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failure = failure ?? `${object}: ${message}`;
        log(`[reconcile] ${object} FAILED ${message}`);
      }
    }
  } finally {
    const finishedAtMs = Date.now();
    const ok = !failure;
    await finishSyncRun(syncRunId, {
      status: ok ? 'success' : 'failed',
      records_read: rows.reduce((total, row) => total + row.salesforceCount, 0),
      records_written: 0,
      ...(failure ? { error: failure } : {}),
      details: { source: 'soql', duration_ms: finishedAtMs - startedAtMs, rows },
    });

    return {
      syncRunId,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      rows,
      ok,
    };
  }
}
