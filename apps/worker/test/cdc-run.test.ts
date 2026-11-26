/**
 * `cdc` sync runs — audit P1-3.
 *
 * `startSyncRun` used to be called only by the bulk extractor and the reconciler,
 * so `GET /api/crm/sync/status` answered `running: false` and the dashboard showed
 * a grey "Idle" pill while four checkpoints were live and events were being
 * applied. The consumer now owns one `cdc` run per lifetime: opened on
 * `start()`, closed on `stop()` (or after every topic has been down for the idle
 * window), with per-run counters and `details.latency_ms`.
 *
 * Real gRPC + real Avro + real Postgres, like `cdc.test.ts`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  applySalesforceRecord,
  closePool,
  markCdcEventProcessed,
  query,
  queryOne,
  recordCdcEvent,
} from '@poc/core';
import { redriveFailedEvents, startConsumer, type CdcConsumer } from '@poc/salesforce';

import {
  OPPORTUNITY_TOPIC,
  disconnectStreams,
  emitChange,
  testSalesforceId,
  uniqueSuffix,
  waitFor,
} from './helpers';

const createdIds: string[] = [];
const channels: string[] = [];
const syncRunIds: string[] = [];

function makeId(): string {
  const id = testSalesforceId('006VITEST');
  createdIds.push(id);
  return id;
}

function makeChannel(label: string): string {
  const channel = `${OPPORTUNITY_TOPIC}#vitest-run-${label}-${uniqueSuffix()}`;
  channels.push(channel);
  return channel;
}

/** Pull the `sync_run=<uuid> open` id out of the consumer's own log lines. */
function runIdFromLogs(logs: string[]): string | null {
  for (const line of logs) {
    const match = /sync_run=([0-9a-f-]{36}) open/.exec(line);
    if (match) return match[1];
  }
  return null;
}

async function readRun(id: string) {
  return queryOne<{
    kind: string;
    status: string;
    records_read: number;
    records_written: number;
    error: string | null;
    details: Record<string, unknown> | null;
    finished_at: string | null;
  }>(
    `SELECT kind, status, records_read, records_written, error, details, finished_at
       FROM sync_runs WHERE id = $1`,
    [id],
  );
}

afterAll(async () => {
  for (const id of createdIds) {
    await emitChange({ object: 'Opportunity', changeType: 'DELETE', record: { Id: id } }).catch(
      () => undefined,
    );
  }
  await query(`DELETE FROM opportunities WHERE salesforce_id LIKE '006VITEST%'`);
  for (const channel of channels) {
    await query(`DELETE FROM cdc_events WHERE channel = $1`, [channel]);
    await query(`DELETE FROM cdc_checkpoints WHERE channel = $1`, [channel]);
  }
  for (const id of syncRunIds) {
    await query(`DELETE FROM sync_runs WHERE id = $1`, [id]);
  }
  await closePool();
});

describe('cdc sync runs (audit P1-3)', () => {
  it('opens one cdc run per consumer lifetime and closes it with counters + latency', async () => {
    const id = makeId();
    const channel = makeChannel('life');
    const logs: string[] = [];
    let consumer: CdcConsumer | null = null;
    let runId: string | null = null;

    try {
      consumer = await startConsumer({
        topics: [OPPORTUNITY_TOPIC],
        channelForTopic: () => channel,
        minBackoffMs: 150,
        maxBackoffMs: 800,
        log: (line) => logs.push(line),
      });
      await consumer.ready();

      // The run must exist while the consumer is up, not only at the end.
      runId = await waitFor(
        async () => {
          const candidate = runIdFromLogs(logs);
          if (!candidate) return null;
          const row = await readRun(candidate);
          return row && row.status === 'running' ? candidate : null;
        },
        { timeoutMs: 10_000, label: 'cdc sync run opened' },
      );
      syncRunIds.push(runId);

      const started = await readRun(runId);
      expect(started?.kind).toBe('cdc');
      expect(started?.status).toBe('running');
      expect(started?.finished_at).toBeNull();
      expect((started?.details as Record<string, unknown>)?.topics).toEqual([OPPORTUNITY_TOPIC]);

      await emitChange({
        object: 'Opportunity',
        changeType: 'CREATE',
        record: {
          Id: id,
          Name: 'Vitest cdc sync run',
          StageName: 'Prospecting',
          Amount: 1_000,
          OwnerName: 'Dana Whitfield',
        },
      });
      // `records_read`/`records_written` are written once, when the run closes;
      // while it is running the counters live in `cdc_events`. Wait for this
      // consumer's own channel to have applied the event.
      await waitFor(
        async () => {
          const row = await queryOne<{ total: number }>(
            `SELECT count(*)::int AS total FROM cdc_events
              WHERE channel = $1 AND status IN ('applied', 'skipped_stale')`,
            [channel],
          );
          return (row?.total ?? 0) >= 1 ? row : null;
        },
        { timeoutMs: 15_000, label: 'cdc event applied' },
      );

      // `running: true` is what removes the dashboard's "Idle" pill.
      const running = await queryOne<{ running: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM sync_runs WHERE status = 'running') AS running`,
      );
      expect(running?.running).toBe(true);
    } finally {
      await consumer?.stop();
    }

    const closed = await waitFor(
      async () => {
        const row = await readRun(runId as string);
        return row && row.status !== 'running' ? row : null;
      },
      { timeoutMs: 10_000, label: 'cdc sync run closed on stop' },
    );
    expect(closed.status).toBe('success');
    expect(closed.finished_at).not.toBeNull();
    expect(closed.records_read).toBeGreaterThanOrEqual(1);
    expect(closed.records_written).toBeGreaterThanOrEqual(1);

    const details = closed.details as {
      source: string;
      topics: string[];
      applied: number;
      skipped_stale: number;
      failed: number;
      duplicates: number;
      latency_ms: { p50: number | null; max: number | null; samples: number };
      close_reason: string;
      duration_ms: number;
    };
    expect(details.source).toBe('pubsub');
    expect(details.topics).toEqual([OPPORTUNITY_TOPIC]);
    expect(details.close_reason).toBe('consumer stopped');
    expect(details.applied).toBeGreaterThanOrEqual(1);
    expect(details.failed).toBe(0);
    expect(details.latency_ms.samples).toBeGreaterThanOrEqual(1);
    expect(typeof details.latency_ms.p50).toBe('number');
    expect(details.latency_ms.max).toBeGreaterThanOrEqual(details.latency_ms.p50 as number);
  });

  it('closes the cdc run when a topic is down past the idle window and opens a new one on reconnect', async () => {
    const logs: string[] = [];
    const consumer = await startConsumer({
      topics: [OPPORTUNITY_TOPIC],
      channelForTopic: () => makeChannel('idle'),
      // Longer than the idle window on purpose: the idle close must win the race
      // against the reconnect, which is exactly the "reconnecting > 30s" case.
      minBackoffMs: 5_000,
      maxBackoffMs: 5_000,
      syncRunIdleCloseMs: 400,
      syncRunWatchdogMs: 100,
      log: (line) => logs.push(line),
    });
    try {
      await consumer.ready();
      const firstRun = await waitFor(async () => runIdFromLogs(logs), {
        timeoutMs: 10_000,
        label: 'cdc run opened',
      });
      syncRunIds.push(firstRun);

      // Real server-side interruption (the e2e helper the recovery test uses).
      await disconnectStreams(OPPORTUNITY_TOPIC);

      const closed = await waitFor(
        async () => {
          const row = await readRun(firstRun);
          return row && row.status !== 'running' ? row : null;
        },
        { timeoutMs: 15_000, label: 'idle cdc run closed' },
      );
      expect((closed.details as { close_reason: string }).close_reason).toBe('disconnected');

      // …and the reconnect opens a fresh run, so `running` is true again.
      const secondRun = await waitFor(
        async () => {
          const ids = new Set(
            logs
              .map((line) => /sync_run=([0-9a-f-]{36}) open/.exec(line)?.[1])
              .filter((id): id is string => Boolean(id)),
          );
          const next = [...ids].find((id) => id !== firstRun);
          if (!next) return null;
          const row = await readRun(next);
          return row && row.status === 'running' ? next : null;
        },
        { timeoutMs: 20_000, label: 'cdc run reopened after the reconnect' },
      );
      syncRunIds.push(secondRun);
    } finally {
      await consumer.stop();
    }
  });
});

describe('redriveFailedEvents (audit P0-2)', () => {
  it('re-applies a dead-lettered event: still_failing while broken, applied after the fix', async () => {
    const id = makeId();
    // A channel name no consumer subscribes to: this test drives the redrive
    // path only, so no real topic/stream is touched.
    const channel = `${OPPORTUNITY_TOPIC}#vitest-redrive-${uniqueSuffix()}`;
    channels.push(channel);
    const replayId = BigInt(Date.now()) * 1_000n + BigInt(Math.floor(Math.random() * 1_000));
    const eventId = `${channel}:${replayId.toString()}`;

    // A real row for the record, then the CDC event core would reject.
    // The `SystemModstamp` matters: core refuses timestamp-less writes (P1-1),
    // and a real CDC payload always carries one.
    const stamp = new Date(Date.now() + 1_000).toISOString();
    const seeded = await applySalesforceRecord('Opportunity', 'CREATE', {
      Id: id,
      Name: 'Vitest redrive',
      StageName: 'Qualification',
      Amount: 700,
      SystemModstamp: stamp,
    });
    expect(seeded.outcome).toBe('applied');

    await recordCdcEvent({
      event_id: eventId,
      channel,
      object_name: 'Opportunity',
      record_id: id,
      change_type: 'UPDATE',
      replay_id: replayId,
      payload: { Id: id, StageName: 'Closed Won – Renewal', Amount: 900, SystemModstamp: stamp },
    });
    await markCdcEventProcessed(eventId, 'failed', {
      error: 'unmapped StageName: "Closed Won – Renewal"',
    });

    const quiet = () => undefined;

    // 1. Still broken: the redrive reports it and leaves the row failed.
    const first = await redriveFailedEvents({ log: quiet });
    expect(first.attempted).toBeGreaterThanOrEqual(1);
    expect(first.still_failing).toBeGreaterThanOrEqual(1);
    let row = await queryOne<{ status: string; error: string | null }>(
      `SELECT status, error FROM cdc_events WHERE event_id = $1`,
      [eventId],
    );
    expect(row?.status).toBe('failed');

    // 2. Fix the data (repair the stored payload), redrive again.
    await query(
      `UPDATE cdc_events SET payload = payload || '{"StageName":"Proposal"}'::jsonb
        WHERE event_id = $1`,
      [eventId],
    );
    const second = await redriveFailedEvents({ log: quiet });
    expect(second.applied).toBeGreaterThanOrEqual(1);

    row = await queryOne<{ status: string; error: string | null; processed_at: string | null }>(
      `SELECT status, error, processed_at::text FROM cdc_events WHERE event_id = $1`,
      [eventId],
    );
    expect(row?.status).toBe('applied');
    expect(row?.error).toBeNull();
    expect(row?.processed_at).not.toBeNull();

    const opportunity = await queryOne<{ stage: string; amount: string }>(
      `SELECT stage, amount FROM opportunities WHERE salesforce_id = $1`,
      [id],
    );
    expect(opportunity?.stage).toBe('Proposal');
    expect(Number(opportunity?.amount)).toBe(900);
  });
});
