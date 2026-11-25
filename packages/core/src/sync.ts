/**
 * Sync bookkeeping — sync runs, CDC checkpoints and the CDC event log
 * (docs/CONTRACTS.md §3). Replay ids are 64-bit: they are stored as `bigint`
 * and always serialised as strings.
 */
import { query, queryOne } from './db';
import { notFound, validationError } from './errors';
import { isUuid } from './ids';
import { normalizeLimit } from './pagination';
import {
  mapCdcEvent,
  mapCheckpoint,
  mapSyncRun,
  type CdcCheckpointRow,
  type CdcEventRow,
  type SyncRunRow,
} from './rows';
import type {
  CdcCheckpoint,
  CdcEvent,
  CdcEventStatus,
  ChangeType,
  CheckpointPatch,
  RecordCdcEventInput,
  SyncRun,
  SyncRunKind,
  SyncRunPatch,
} from './types';
import {
  cdcEventStatusSchema,
  changeTypeSchema,
  syncRunKindSchema,
  syncRunStatusSchema,
  validate,
} from './validation';

const SYNC_RUN_COLUMNS = `id, kind, status, started_at, finished_at, records_read,
  records_written, error, details`;

const CDC_EVENT_COLUMNS = `id, event_id, channel, object_name, record_id, change_type,
  replay_id, payload, status, error, latency_ms, received_at, processed_at`;

/**
 * Replay ids are 64-bit signed integers. Accept `bigint`, number or string and
 * normalise to a decimal string so pg never receives a lossy JS float.
 */
export function toReplayId(value: bigint | number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'bigint' ? value.toString() : String(value).trim();
  if (raw === '') return null;
  if (!/^-?\d+$/.test(raw)) {
    throw validationError('replay_id must be a 64-bit integer', { replay_id: 'invalid replay id' });
  }
  return raw;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError(`${field} is required`, { [field]: 'required' });
  }
  return value.trim();
}

// ------------------------------------------------------------- sync runs

export async function startSyncRun(kind: SyncRunKind, details?: unknown): Promise<string> {
  const validatedKind = validate(syncRunKindSchema, kind);
  const row = await queryOne<{ id: string }>(
    `INSERT INTO sync_runs (kind, details) VALUES ($1, $2::jsonb) RETURNING id`,
    [validatedKind, details === undefined ? null : JSON.stringify(details)],
  );
  if (!row) throw new Error('failed to start sync run');
  return row.id;
}

export async function finishSyncRun(id: string, patch: SyncRunPatch): Promise<void> {
  const status = validate(syncRunStatusSchema, patch?.status);
  if (status === 'running') {
    throw validationError('finishSyncRun cannot set status back to running', { status: 'invalid' });
  }
  if (!isUuid(id)) throw notFound('sync run', id);

  const result = await queryOne<{ id: string }>(
    `UPDATE sync_runs
        SET status = $2,
            finished_at = now(),
            records_read = COALESCE($3, records_read),
            records_written = COALESCE($4, records_written),
            error = $5,
            details = COALESCE($6::jsonb, details)
      WHERE id = $1
      RETURNING id`,
    [
      id,
      status,
      patch.records_read ?? null,
      patch.records_written ?? null,
      patch.error ?? null,
      patch.details === undefined ? null : JSON.stringify(patch.details),
    ],
  );
  if (!result) throw notFound('sync run', id);
}

export async function listSyncRuns(limit?: number): Promise<SyncRun[]> {
  const capped = normalizeLimit(limit, 20);
  const rows = await query<SyncRunRow>(
    `SELECT ${SYNC_RUN_COLUMNS} FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT $1`,
    [capped],
  );
  return rows.map(mapSyncRun);
}

// ------------------------------------------------------------ checkpoints

export async function getCheckpoint(channel: string): Promise<CdcCheckpoint | null> {
  const name = requireNonEmpty(channel, 'channel');
  const row = await queryOne<CdcCheckpointRow>(
    `SELECT channel, replay_id, last_event_at, status, error, updated_at
       FROM cdc_checkpoints WHERE channel = $1`,
    [name],
  );
  return row ? mapCheckpoint(row) : null;
}

/**
 * Upsert a checkpoint. `replay_id` and `last_event_at` are only advanced when a
 * new value is supplied (COALESCE against the stored row); `status`/`error` are
 * always written.
 */
export async function saveCheckpoint(
  channel: string,
  replayId: bigint | number | string | null,
  patch: CheckpointPatch = {},
): Promise<void> {
  const name = requireNonEmpty(channel, 'channel');
  const replay = toReplayId(replayId);
  const status = patch.status ?? null;
  const lastEventAt =
    patch.last_event_at === undefined || patch.last_event_at === null
      ? null
      : (() => {
          if (Number.isNaN(Date.parse(patch.last_event_at as string))) {
            throw validationError('last_event_at must be an ISO timestamp', {
              last_event_at: 'invalid timestamp',
            });
          }
          return new Date(patch.last_event_at as string).toISOString();
        })();

  await query(
    `INSERT INTO cdc_checkpoints (channel, replay_id, last_event_at, status, error, updated_at)
     VALUES ($1, $2::bigint, COALESCE($3::timestamptz, now()), COALESCE($4, 'idle'), $5, now())
     ON CONFLICT (channel) DO UPDATE SET
       replay_id     = COALESCE(EXCLUDED.replay_id, cdc_checkpoints.replay_id),
       last_event_at = COALESCE($3::timestamptz, cdc_checkpoints.last_event_at),
       status        = COALESCE($4, cdc_checkpoints.status),
       error         = COALESCE(EXCLUDED.error, cdc_checkpoints.error),
       updated_at    = now()`,
    [name, replay, lastEventAt, status, patch.error ?? null],
  );
}

// ------------------------------------------------------------ cdc events

/** Insert one CDC event; returns `{ duplicate: true }` when the event_id exists. */
export async function recordCdcEvent(input: RecordCdcEventInput): Promise<{ duplicate: boolean }> {
  const eventId = requireNonEmpty(input?.event_id, 'event_id');
  const channel = requireNonEmpty(input?.channel, 'channel');
  const objectName = requireNonEmpty(input?.object_name, 'object_name');
  const recordId = requireNonEmpty(input?.record_id, 'record_id');
  const changeType: ChangeType = validate(changeTypeSchema, input?.change_type);
  const replayId = toReplayId(input?.replay_id ?? null);

  const row = await queryOne<{ id: string }>(
    `INSERT INTO cdc_events
       (event_id, channel, object_name, record_id, change_type, replay_id, payload, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::jsonb, $8)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id`,
    [
      eventId,
      channel,
      objectName,
      recordId,
      changeType,
      replayId,
      input?.payload === undefined ? null : JSON.stringify(input.payload),
      input?.latency_ms ?? null,
    ],
  );
  return { duplicate: !row };
}

export async function markCdcEventProcessed(
  eventId: string,
  status: CdcEventStatus,
  patch: { error?: string } = {},
): Promise<void> {
  const id = requireNonEmpty(eventId, 'event_id');
  const validated = validate(cdcEventStatusSchema, status);
  const row = await queryOne<{ id: string }>(
    `UPDATE cdc_events
        SET status = $2, error = COALESCE($3, error), processed_at = now()
      WHERE event_id = $1
      RETURNING id`,
    [id, validated, patch.error ?? null],
  );
  if (!row) throw notFound('cdc event', id);
}

export async function listCdcEvents(params: {
  limit?: number;
  status?: CdcEventStatus;
} = {}): Promise<CdcEvent[]> {
  const capped = normalizeLimit(params.limit, 50);
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params.status !== undefined && params.status !== null) {
    const parsed = cdcEventStatusSchema.safeParse(params.status);
    if (!parsed.success) {
      throw validationError('status is not a valid cdc event status', { status: 'invalid status' });
    }
    values.push(parsed.data);
    conditions.push(`status = $${values.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(capped);
  const rows = await query<CdcEventRow>(
    `SELECT ${CDC_EVENT_COLUMNS} FROM cdc_events ${where}
      ORDER BY received_at DESC, id DESC LIMIT $${values.length}`,
    values,
  );
  return rows.map(mapCdcEvent);
}
