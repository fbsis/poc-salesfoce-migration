/**
 * CDC consumer against the live mock (real gRPC + real Avro) and real Postgres.
 *
 * Covers: Avro decode shape, dedupe + apply, stale-write guard through CDC, and
 * checkpoint replay after an interruption (stop → emit → restart).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { applySalesforceRecord, closePool, query, queryOne } from '@poc/core';
import { readEvents, startConsumer, stopConsumer, type CdcConsumer } from '@poc/salesforce';

import {
  OPPORTUNITY_TOPIC,
  emitChange,
  mockState,
  sleep,
  testSalesforceId,
  uniqueSuffix,
  waitFor,
} from './helpers';

const channels: string[] = [];
const createdIds: string[] = [];

function makeChannel(label: string): string {
  const channel = `${OPPORTUNITY_TOPIC}#vitest-${label}-${uniqueSuffix()}`;
  channels.push(channel);
  return channel;
}

function makeId(): string {
  const id = testSalesforceId('006VITEST');
  createdIds.push(id);
  return id;
}

function newConsumer(channel: string, log?: (line: string) => void): Promise<CdcConsumer> {
  return startConsumer({
    topics: [OPPORTUNITY_TOPIC],
    channelForTopic: () => channel,
    minBackoffMs: 150,
    maxBackoffMs: 800,
    ...(log ? { log } : {}),
  });
}

async function findOpportunity(salesforceId: string) {
  return queryOne<{ stage: string; amount: string; name: string }>(
    `SELECT stage, amount, name FROM opportunities WHERE salesforce_id = $1`,
    [salesforceId],
  );
}

async function waitForStage(salesforceId: string, stage: string, timeoutMs = 10_000) {
  return waitFor(
    async () => {
      const row = await findOpportunity(salesforceId);
      return row && row.stage === stage ? row : null;
    },
    { timeoutMs, label: `${salesforceId} → ${stage}` },
  );
}

/**
 * Wait until this consumer's own channel has logged `count` events **and every
 * one of them reached a terminal status**.
 *
 * The `pending` row is inserted before the apply runs, so waiting only for the
 * count races the apply: the assertions below read `status`/`latency_ms`, which
 * are written when the apply finishes. Waiting for a settled log is not a
 * weaker assertion — it is the same one, without reading a row mid-transition.
 */
async function waitForSettledEvents<T extends { status: string }>(
  channel: string,
  count: number,
  timeoutMs = 10_000,
): Promise<T[]> {
  return waitFor(
    async () => {
      const rows = await query<T>(
        `SELECT event_id, change_type, status, latency_ms
           FROM cdc_events WHERE channel = $1 ORDER BY id`,
        [channel],
      );
      if (rows.length < count) return null;
      if (rows.some((row) => row.status === 'pending')) return null;
      return rows;
    },
    { timeoutMs, label: `${channel} → ${count} settled events` },
  );
}

afterAll(async () => {
  await stopConsumer();
  for (const id of createdIds) {
    // Remove the record from the mock dataset too, so later bulk runs do not
    // pick up test rows (DELETE keeps it with IsDeleted=true → excluded).
    await emitChange({ object: 'Opportunity', changeType: 'DELETE', record: { Id: id } }).catch(
      () => undefined,
    );
  }
  await query(`DELETE FROM opportunities WHERE salesforce_id LIKE '006VITEST%'`);
  for (const channel of channels) {
    await query(`DELETE FROM cdc_events WHERE channel = $1`, [channel]);
    await query(`DELETE FROM cdc_checkpoints WHERE channel = $1`, [channel]);
  }
  await closePool();
});

describe('CDC (Pub/Sub gRPC + Avro)', () => {
  it('decodes an Avro UPDATE event emitted by the mock', async () => {
    const id = makeId();
    const created = await emitChange({
      object: 'Opportunity',
      changeType: 'CREATE',
      record: {
        Id: id,
        Name: 'Vitest avro decode',
        StageName: 'Prospecting',
        Amount: 1000,
        OwnerName: 'Dana Whitfield',
      },
    });
    expect(created.ok).toBe(true);

    const updated = await emitChange({
      object: 'Opportunity',
      changeType: 'UPDATE',
      record: { Id: id, StageName: 'Negotiation', Amount: 15000 },
    });
    expect(updated.changedFields).toContain('StageName');

    const events = await readEvents({
      topic: OPPORTUNITY_TOPIC,
      preset: 'CUSTOM',
      replayId: BigInt(created.replayId),
      limit: 1,
      timeoutMs: 8_000,
    });
    expect(events).toHaveLength(1);

    const event = events[0];
    const header = event.decoded.ChangeEventHeader;
    expect(header.entityName).toBe('Opportunity');
    expect(header.changeType).toBe('UPDATE');
    // The top-level Id only exists inside ChangeEventHeader.recordIds.
    expect(header.recordIds).toEqual([id]);
    expect(header.changedFields).toContain('StageName');
    expect(header.commitTimestamp).toBeGreaterThan(0);
    expect((event.decoded as Record<string, unknown>).Id).toBeUndefined();
    expect((event.decoded as Record<string, unknown>).StageName).toBe('Negotiation');
    expect((event.decoded as Record<string, unknown>).Amount).toBe(15000);
    expect(event.replayId).toBe(BigInt(updated.replayId));
  });

  it('applies CREATE then UPDATE and records latency', async () => {
    const id = makeId();
    const channel = makeChannel('apply');
    const consumer = await newConsumer(channel);
    try {
      // Only emit once our own subscription is live: the mock's LATEST preset
      // only drains its deferred queue when *no* subscriber exists, and the
      // demo worker container may also be listening on this topic.
      await consumer.ready();
      const created = await emitChange({
        object: 'Opportunity',
        changeType: 'CREATE',
        record: {
          Id: id,
          Name: 'Vitest cdc apply',
          StageName: 'Prospecting',
          Amount: 1000,
          AccountId: (await mockState()).dataset.accounts[0]?.Id,
          OwnerName: 'Dana Whitfield',
        },
      });
      expect(created.ok).toBe(true);

      await emitChange({
        object: 'Opportunity',
        changeType: 'UPDATE',
        record: { Id: id, StageName: 'Negotiation', Amount: 15000 },
      });

      // The row may also be written by the demo worker container; wait for this
      // consumer's own bookkeeping before asserting the row and the log.
      const events = await waitForSettledEvents<{
        event_id: string;
        change_type: string;
        status: string;
        latency_ms: number | null;
      }>(channel, 2);
      const row = await waitForStage(id, 'Negotiation');
      expect(Number(row.amount)).toBe(15000);
      expect(row.name).toBe('Vitest cdc apply');

      expect(events).toHaveLength(2);
      expect(events.map((event) => event.change_type)).toEqual(['CREATE', 'UPDATE']);
      for (const event of events) {
        // If the demo worker container is consuming the same topic it may apply
        // the newer version first, in which case this channel records the older
        // CREATE as skipped_stale. The newest event (the UPDATE) is always
        // applied, and nothing is ever written twice.
        expect(['applied', 'skipped_stale']).toContain(event.status);
        expect(event.latency_ms).not.toBeNull();
        // `latency_ms = now - ChangeEventHeader.commitTimestamp` in whole ms, so
        // a warm stack that applies the event in the same millisecond records 0
        // (the mock's commitTimestamp is strictly increasing and can even be a
        // little ahead of wall-clock). What matters is that it is measured and
        // bounded; capability 3 in apps/web/test/e2e proves a positive value on
        // events that had to wait for a replay.
        expect(Number(event.latency_ms)).toBeGreaterThanOrEqual(0);
        expect(Number(event.latency_ms)).toBeLessThan(30_000);
        expect(event.event_id.startsWith(`${channel}:`)).toBe(true);
      }
      expect(events[events.length - 1].status).toBe('applied');
    } finally {
      await consumer.stop();
    }
  });

  it('skips a stale UPDATE (older SystemModstamp than the stored row)', async () => {
    const id = makeId();
    const channel = makeChannel('stale');
    // Local row is already newer than anything the mock can emit: the mock
    // stamps SystemModstamp with the emit time, so a future stored timestamp
    // makes every incoming event older.
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const seeded = await applySalesforceRecord('Opportunity', 'CREATE', {
      Id: id,
      Name: 'Vitest stale guard',
      StageName: 'Proposal',
      Amount: 100,
      SystemModstamp: future,
    });
    expect(seeded.outcome).toBe('applied');

    const consumer = await newConsumer(channel);
    try {
      await consumer.ready();
      await emitChange({
        object: 'Opportunity',
        changeType: 'UPDATE',
        record: { Id: id, StageName: 'Negotiation', Amount: 999 },
      });

      const event = await waitFor(
        async () => {
          const row = await queryOne<{ status: string; latency_ms: number | null }>(
            `SELECT status, latency_ms FROM cdc_events
              WHERE channel = $1 AND record_id = $2 AND change_type = 'UPDATE'`,
            [channel, id],
          );
          // `pending` means the apply has not finished yet: wait for it instead
          // of asserting on a row that is still being written.
          return row && row.status !== 'pending' ? row : null;
        },
        { timeoutMs: 10_000, label: 'stale event recorded' },
      );

      expect(event.status).toBe('skipped_stale');
      const row = await findOpportunity(id);
      expect(row?.stage).toBe('Proposal');
      expect(Number(row?.amount)).toBe(100);
    } finally {
      await consumer.stop();
    }
  });

  it('replays from the checkpoint after an interruption without duplicating events', async () => {
    const id = makeId();
    const channel = makeChannel('replay');
    const logs: string[] = [];

    const first = await newConsumer(channel, (line) => logs.push(line));
    try {
      await first.ready();
      await emitChange({
        object: 'Opportunity',
        changeType: 'CREATE',
        record: {
          Id: id,
          Name: 'Vitest replay',
          StageName: 'Prospecting',
          Amount: 1000,
          OwnerName: 'Marcus Lee',
        },
      });
      await waitForStage(id, 'Prospecting');

      // The checkpoint must be durable before we call the interruption.
      await waitFor(
        async () => {
          const checkpoint = await queryOne<{ replay_id: string | null }>(
            `SELECT replay_id FROM cdc_checkpoints WHERE channel = $1 AND replay_id IS NOT NULL`,
            [channel],
          );
          return checkpoint ?? null;
        },
        { timeoutMs: 10_000, label: 'checkpoint persisted' },
      );
    } finally {
      await first.stop();
    }

    // Emitted while nobody is subscribed: the ring buffer holds them and a
    // CUSTOM replay from the checkpoint must find them.
    await emitChange({
      object: 'Opportunity',
      changeType: 'UPDATE',
      record: { Id: id, StageName: 'Qualification', Amount: 2000 },
    });
    await emitChange({
      object: 'Opportunity',
      changeType: 'UPDATE',
      record: { Id: id, StageName: 'Proposal', Amount: 3000 },
    });
    await sleep(250);

    const second = await newConsumer(channel, (line) => logs.push(line));
    try {
      await second.ready();
      const row = await waitForStage(id, 'Proposal');
      expect(Number(row.amount)).toBe(3000);
      await waitForSettledEvents(channel, 3);
      expect(logs.some((line) => line.includes('preset=CUSTOM'))).toBe(true);
    } finally {
      await second.stop();
    }

    const events = await query<{ event_id: string; replay_id: string; status: string }>(
      `SELECT event_id, replay_id, status FROM cdc_events
        WHERE channel = $1 ORDER BY replay_id::bigint`,
      [channel],
    );
    expect(events).toHaveLength(3);
    // No duplicate event_id / replay_id, no extra rows from the replay.
    expect(new Set(events.map((event) => event.event_id)).size).toBe(3);
    expect(new Set(events.map((event) => event.replay_id)).size).toBe(3);
    // The newest replayed event is applied; an older one may be skipped_stale
    // if the demo worker container already advanced the row.
    expect(events.every((event) => ['applied', 'skipped_stale'].includes(event.status))).toBe(true);
    expect(events[events.length - 1].status).toBe('applied');
  });
});
