/**
 * Reporting — see docs/CONTRACTS.md §3.
 * Every function is empty-safe: aggregates return zeroes and no function throws
 * because the database has no rows yet.
 */
import { query, queryOne } from './db';
import { validationError } from './errors';
import { intZero, mapLead, mapSyncRun, mapCheckpoint, iso, type LeadRow, type SyncRunRow } from './rows';
import type {
  CdcCheckpoint,
  Lead,
  LeadSource,
  LeadStatus,
  LeadSummary,
  LeadSummaryParams,
  OpportunityStage,
  SalesSummary,
  StageSummary,
  SyncRun,
  SyncStatus,
} from './types';
import { LEAD_SOURCES, LEAD_STATUSES, OPPORTUNITY_STAGES } from './types';
const LEAD_COLUMNS = `l.id, l.salesforce_id, l.full_name, l.email, l.phone, l.company,
  l.property_interest, l.message, l.status, l.source, l.consent, l.consent_at,
  l.salesforce_updated_at, l.synced_at, l.created_at, l.updated_at`;

const SYNC_RUN_COLUMNS = `id, kind, status, started_at, finished_at, records_read,
  records_written, error, details`;

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function requireTimestamp(value: string, field: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw validationError(`${field} must be an ISO timestamp`, { [field]: 'invalid timestamp' });
  }
  return new Date(value).toISOString();
}

export async function getSalesSummary(): Promise<SalesSummary> {
  const row = await queryOne<{
    accounts: number;
    contacts: number;
    opportunities: number;
    leads: number;
    pipeline_value: string | number | null;
    won_value: string | number | null;
    open_opportunities: number;
    new_leads: number;
    salesforce_records: number;
    local_records: number;
  }>(`
    SELECT
      (SELECT count(*) FROM accounts)::int AS accounts,
      (SELECT count(*) FROM contacts)::int AS contacts,
      (SELECT count(*) FROM opportunities)::int AS opportunities,
      (SELECT count(*) FROM leads)::int AS leads,
      (SELECT COALESCE(sum(amount), 0) FROM opportunities
        WHERE stage NOT IN ('Closed Won', 'Closed Lost')) AS pipeline_value,
      (SELECT COALESCE(sum(amount), 0) FROM opportunities
        WHERE stage = 'Closed Won') AS won_value,
      (SELECT count(*) FROM opportunities
        WHERE stage NOT IN ('Closed Won', 'Closed Lost'))::int AS open_opportunities,
      (SELECT count(*) FROM leads WHERE status = 'new')::int AS new_leads,
      ((SELECT count(*) FROM accounts WHERE source = 'salesforce')
       + (SELECT count(*) FROM contacts WHERE source = 'salesforce')
       + (SELECT count(*) FROM opportunities WHERE source = 'salesforce')
       + (SELECT count(*) FROM leads WHERE source = 'salesforce'))::int AS salesforce_records,
      ((SELECT count(*) FROM accounts WHERE source <> 'salesforce')
       + (SELECT count(*) FROM contacts WHERE source <> 'salesforce')
       + (SELECT count(*) FROM opportunities WHERE source <> 'salesforce')
       + (SELECT count(*) FROM leads WHERE source <> 'salesforce'))::int AS local_records
  `);

  return {
    accounts: intZero(row?.accounts),
    contacts: intZero(row?.contacts),
    opportunities: intZero(row?.opportunities),
    leads: intZero(row?.leads),
    pipelineValue: num(row?.pipeline_value),
    wonValue: num(row?.won_value),
    openOpportunities: intZero(row?.open_opportunities),
    newLeads: intZero(row?.new_leads),
    salesforceRecords: intZero(row?.salesforce_records),
    localRecords: intZero(row?.local_records),
  };
}

/** Always returns all six stages, in canonical order, including empty ones. */
export async function getOpportunitiesByStage(): Promise<StageSummary[]> {
  const rows = await query<{ stage: OpportunityStage; count: number; total_amount: string | number | null }>(
    `SELECT stage, count(*)::int AS count, COALESCE(sum(amount), 0) AS total_amount
       FROM opportunities GROUP BY stage`,
  );
  const byStage = new Map<string, { count: number; totalAmount: number }>();
  for (const row of rows) {
    byStage.set(row.stage, { count: intZero(row.count), totalAmount: num(row.total_amount) });
  }
  return OPPORTUNITY_STAGES.map((stage) => ({
    stage,
    count: byStage.get(stage)?.count ?? 0,
    totalAmount: byStage.get(stage)?.totalAmount ?? 0,
  }));
}

export async function getLeadSummary(params: LeadSummaryParams = {}): Promise<LeadSummary> {
  const since =
    params.since === undefined || params.since === null
      ? null
      : requireTimestamp(params.since, 'since');

  const where = since === null ? '' : 'WHERE l.created_at >= $1::timestamptz';
  const values: unknown[] = since === null ? [] : [since];

  const totalRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM leads l ${where}`,
    values,
  );

  const statusRows = await query<{ status: LeadStatus; count: number }>(
    `SELECT l.status AS status, count(*)::int AS count FROM leads l ${where} GROUP BY l.status`,
    values,
  );
  const sourceRows = await query<{ source: LeadSource; count: number }>(
    `SELECT l.source AS source, count(*)::int AS count FROM leads l ${where} GROUP BY l.source`,
    values,
  );

  const todayWhere = since === null
    ? `WHERE l.created_at >= date_trunc('day', now())`
    : `WHERE l.created_at >= date_trunc('day', now()) AND l.created_at >= $1::timestamptz`;
  const todayRow = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM leads l ${todayWhere}`,
    values,
  );

  const latestRows = await query<LeadRow>(
    `SELECT ${LEAD_COLUMNS} FROM leads l ${where}
      ORDER BY l.created_at DESC, l.id DESC LIMIT 5`,
    values,
  );

  const statusCounts = new Map(statusRows.map((row) => [row.status, intZero(row.count)]));
  const sourceCounts = new Map(sourceRows.map((row) => [row.source, intZero(row.count)]));

  return {
    total: intZero(totalRow?.total),
    byStatus: LEAD_STATUSES.map((status) => ({ status, count: statusCounts.get(status) ?? 0 })),
    bySource: LEAD_SOURCES.map((source) => ({ source, count: sourceCounts.get(source) ?? 0 })),
    newToday: intZero(todayRow?.count),
    latest: latestRows.map(mapLead),
  };
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const runningRow = await queryOne<{ running: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM sync_runs WHERE status = 'running') AS running`,
  );

  const lastBulkRow = await queryOne<SyncRunRow>(
    `SELECT ${SYNC_RUN_COLUMNS} FROM sync_runs WHERE kind = 'bulk_extract'
      ORDER BY started_at DESC, id DESC LIMIT 1`,
  );

  const lastBulkRun: SyncRun | null = lastBulkRow ? mapSyncRun(lastBulkRow) : null;

  const checkpointRows = await query<{
    channel: string;
    replay_id: string | null;
    last_event_at: Date | string | null;
    status: string;
    error: string | null;
    updated_at: Date | string;
  }>(
    `SELECT channel, replay_id, last_event_at, status, error, updated_at
       FROM cdc_checkpoints ORDER BY channel ASC`,
  );
  const checkpoints: CdcCheckpoint[] = checkpointRows.map(mapCheckpoint);

  const countsRow = await queryOne<{
    cdc_events: number;
    failed_events: number;
    stale_skipped: number;
  }>(
    `SELECT
       count(*)::int AS cdc_events,
       count(*) FILTER (WHERE status = 'failed')::int AS failed_events,
       count(*) FILTER (WHERE status = 'skipped_stale')::int AS stale_skipped
     FROM cdc_events`,
  );

  const lastEventRow = await queryOne<{ ts: Date | string | null }>(
    `SELECT max(COALESCE(processed_at, received_at)) AS ts FROM cdc_events WHERE status = 'applied'`,
  );
  const lastCdcEventAt = iso(lastEventRow?.ts ?? null);

  return {
    running: runningRow?.running === true,
    lastBulkRun,
    lastCdcEventAt,
    checkpoints,
    counts: {
      cdcEvents: intZero(countsRow?.cdc_events),
      failedEvents: intZero(countsRow?.failed_events),
      staleSkipped: intZero(countsRow?.stale_skipped),
    },
    lagSeconds:
      lastCdcEventAt === null
        ? null
        : Math.max(0, Math.round((Date.now() - Date.parse(lastCdcEventAt)) / 1000)),
  };
}
