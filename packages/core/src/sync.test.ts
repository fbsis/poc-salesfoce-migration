import { afterAll, describe, expect, it } from 'vitest';
import { closePool, query, queryOne } from './db';
import {
  finishSyncRun,
  getCheckpoint,
  listCdcEvents,
  listSyncRuns,
  markCdcEventProcessed,
  recordCdcEvent,
  saveCheckpoint,
  startSyncRun,
  toReplayId,
} from './sync';

const run = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
const channel = `vitest-sync-${run}`;
const syncRunIds: string[] = [];
const eventIds: string[] = [];

afterAll(async () => {
  for (const id of syncRunIds) await query(`DELETE FROM sync_runs WHERE id = $1`, [id]);
  for (const eventId of eventIds) await query(`DELETE FROM cdc_events WHERE event_id = $1`, [eventId]);
  await query(`DELETE FROM cdc_checkpoints WHERE channel = $1`, [channel]);
  await closePool();
});

describe('sync bookkeeping', () => {
  it('starts and finishes a sync run', async () => {
    const id = await startSyncRun('bulk_extract', { source: 'vitest' });
    syncRunIds.push(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const running = await queryOne<{ status: string; details: { source: string } }>(
      `SELECT status, details FROM sync_runs WHERE id = $1`,
      [id],
    );
    expect(running?.status).toBe('running');
    expect(running?.details).toEqual({ source: 'vitest' });

    await finishSyncRun(id, {
      status: 'success',
      records_read: 7,
      records_written: 5,
      details: { objects: ['Account'] },
    });

    const runs = await listSyncRuns(20);
    const finished = runs.find((row) => row.id === id)!;
    expect(finished.status).toBe('success');
    expect(finished.records_read).toBe(7);
    expect(finished.records_written).toBe(5);
    expect(finished.started_at).toBeTypeOf('string');
    expect(finished.finished_at).not.toBeNull();
    expect(finished.details).toEqual({ objects: ['Account'] });

    await expect(
      finishSyncRun('00000000-0000-4000-8000-000000000000', { status: 'failed' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(finishSyncRun(id, { status: 'nope' as never })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('round-trips a checkpoint and never moves the replay id backwards', async () => {
    expect(await getCheckpoint(channel)).toBeNull();

    await saveCheckpoint(channel, 100n, { status: 'connected' });
    let checkpoint = await getCheckpoint(channel);
    expect(checkpoint?.channel).toBe(channel);
    expect(checkpoint?.replay_id).toBe('100');
    expect(checkpoint?.status).toBe('connected');
    expect(typeof checkpoint?.replay_id).toBe('string');

    await saveCheckpoint(channel, 250, { last_event_at: '2025-01-01T00:00:00.000Z' });
    checkpoint = await getCheckpoint(channel);
    expect(checkpoint?.replay_id).toBe('250');
    expect(checkpoint?.status).toBe('connected'); // unchanged when not supplied
    expect(checkpoint?.last_event_at).toBe('2025-01-01T00:00:00.000Z');

    // A null replay id keeps the stored one.
    await saveCheckpoint(channel, null);
    expect((await getCheckpoint(channel))?.replay_id).toBe('250');

    await saveCheckpoint(channel, 300, { status: 'error', error: 'connection lost' });
    checkpoint = await getCheckpoint(channel);
    expect(checkpoint?.replay_id).toBe('300');
    expect(checkpoint?.status).toBe('error');
    expect(checkpoint?.error).toBe('connection lost');
    expect(checkpoint?.last_event_at).toBe('2025-01-01T00:00:00.000Z');

    await expect(saveCheckpoint(channel, 'not-a-number')).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(saveCheckpoint('', 1)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('serialises 64-bit replay ids as strings', async () => {
    expect(toReplayId(9223372036854775807n)).toBe('9223372036854775807');
    const eventId = `${channel}:max`;
    eventIds.push(eventId);

    expect(
      await recordCdcEvent({
        event_id: eventId,
        channel,
        object_name: 'Account',
        record_id: '001000000000000AAA',
        change_type: 'UPDATE',
        replay_id: 9223372036854775807n,
        payload: { maximum: true },
        latency_ms: 42,
      }),
    ).toEqual({ duplicate: false });

    const row = await queryOne<{ replay_id: string; status: string; latency_ms: number }>(
      `SELECT replay_id, status, latency_ms FROM cdc_events WHERE event_id = $1`,
      [eventId],
    );
    expect(row?.replay_id).toBe('9223372036854775807');
    expect(row?.status).toBe('pending');
  });

  it('deduplicates CDC events by event_id and tracks their status', async () => {
    const eventId = `${channel}:dedupe`;
    eventIds.push(eventId);
    const input = {
      event_id: eventId,
      channel,
      object_name: 'Opportunity',
      record_id: '006000000000000AAA',
      change_type: 'UPDATE' as const,
      replay_id: '10',
      payload: { ChangeEventHeader: { changeType: 'UPDATE' } },
    };

    expect(await recordCdcEvent(input)).toEqual({ duplicate: false });
    expect(await recordCdcEvent(input)).toEqual({ duplicate: true });

    const pending = await listCdcEvents({ status: 'pending', limit: 200 });
    const event = pending.find((row) => row.event_id === eventId)!;
    expect(event.id).toBeTypeOf('string');
    expect(event.replay_id).toBe('10');
    expect(event.payload).toEqual({ ChangeEventHeader: { changeType: 'UPDATE' } });
    expect(event.processed_at).toBeNull();

    await markCdcEventProcessed(eventId, 'applied');
    const applied = await listCdcEvents({ status: 'applied', limit: 200 });
    const processed = applied.find((row) => row.event_id === eventId)!;
    expect(processed.processed_at).not.toBeNull();

    await markCdcEventProcessed(eventId, 'failed', { error: 'boom' });
    const failed = await listCdcEvents({ status: 'failed', limit: 200 });
    expect(failed.find((row) => row.event_id === eventId)?.error).toBe('boom');

    await expect(markCdcEventProcessed('unknown:event', 'applied')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(markCdcEventProcessed(eventId, 'bogus' as never)).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(
      recordCdcEvent({ ...input, event_id: `${channel}:bad`, change_type: 'PATCH' as never }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('caps list limits', async () => {
    const events = await listCdcEvents({ limit: 10_000 });
    expect(events.length).toBeLessThanOrEqual(200);
    const runs = await listSyncRuns(10_000);
    expect(runs.length).toBeLessThanOrEqual(200);
  });
});
