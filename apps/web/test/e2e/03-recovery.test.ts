/**
 * Capability 3 — "Synchronization recovers after a temporary interruption".
 *
 * The interruption is real: `POST /mock/disconnect` ends the worker's gRPC
 * stream server-side. Two CDC events are published while nothing is subscribed,
 * which is exactly the failure mode a network blip produces. The consumer must
 * reconnect, resume from its persisted checkpoint (`replayPreset=CUSTOM`), apply
 * both events, and advance the checkpoint — without applying anything twice.
 *
 * The checkpoint is re-read from `/api/crm/sync/status` for every assertion
 * (never cached): the mock and the worker may be restarted between runs.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Opportunity } from '@poc/core';

import {
  RUN,
  api,
  apiJson,
  cdcEvents,
  cleanupE2EData,
  disconnectStreams,
  e2eId,
  emitCdc,
  mockHealth,
  poll,
  syncStatus,
} from './helpers';

interface Single<T> {
  data: T;
}

const OPPORTUNITY_TOPIC = '/data/OpportunityChangeEvent';
const RECOVERY_TIMEOUT = 30_000;

async function getOpportunity(salesforceId: string): Promise<Opportunity | null> {
  const response = await api(`/api/crm/opportunities/${salesforceId}`);
  if (response.status === 404) return null;
  const body = (await response.json()) as Single<Opportunity>;
  return body.data;
}

describe(
  'Capability 3 — synchronization recovers after a temporary interruption',
  { timeout: 60_000 },
  () => {
    afterAll(async () => {
      await cleanupE2EData();
    });

    it('replays events published while disconnected, exactly once, and advances the checkpoint', async () => {
      const ids = [e2eId('006', 'R1'), e2eId('006', 'R2')];

      // --- 1. baseline: the consumer is connected with a saved checkpoint ---
      const before = await syncStatus();
      const beforeCheckpoint = before.checkpoints.find(
        (checkpoint) => checkpoint.channel === OPPORTUNITY_TOPIC,
      );
      expect(beforeCheckpoint, `checkpoint for ${OPPORTUNITY_TOPIC}`).toBeDefined();
      const beforeReplay = BigInt(beforeCheckpoint?.replay_id ?? '0');
      expect(beforeReplay).toBeGreaterThan(0n);
      const beforeHealth = await mockHealth();
      expect(beforeHealth.subscribers).toBeGreaterThanOrEqual(1);

      // --- 2. interrupt the stream (server-side), then publish ---------------
      const disconnected = await disconnectStreams(OPPORTUNITY_TOPIC);
      expect(disconnected.ok).toBe(true);
      expect(disconnected.disconnected).toBeGreaterThanOrEqual(1);

      const first = await emitCdc('Opportunity', 'CREATE', {
        Id: ids[0],
        Name: `E2E recovery 1 ${RUN}`,
        StageName: 'Qualification',
        Amount: 1_100,
        CloseDate: '2026-09-30',
      });
      const second = await emitCdc('Opportunity', 'CREATE', {
        Id: ids[1],
        Name: `E2E recovery 2 ${RUN}`,
        StageName: 'Proposal',
        Amount: 2_200,
        CloseDate: '2026-10-31',
      });

      // Both were published with no subscriber attached: they can only arrive
      // through the mock's ring buffer replay (the consumer reconnects with
      // replayPreset=CUSTOM from cdc_checkpoints.replay_id).
      expect(first.queued, 'first event queued while disconnected').toBe(true);
      expect(second.queued, 'second event queued while disconnected').toBe(true);
      expect(second.replayId).toBeGreaterThan(first.replayId);

      // --- 3. both events land in the CRM within 30s ------------------------
      const landed = await poll(
        async () => {
          const rows = await Promise.all(ids.map((id) => getOpportunity(id)));
          return rows.every((row) => row !== null) ? (rows as Opportunity[]) : null;
        },
        { timeout: RECOVERY_TIMEOUT, interval: 250, label: 'replayed CREATEs applied' },
      );
      expect(landed[0].salesforce_id).toBe(ids[0]);
      expect(landed[0].stage).toBe('Qualification');
      expect(Number(landed[0].amount)).toBe(1_100);
      expect(landed[1].stage).toBe('Proposal');
      expect(Number(landed[1].amount)).toBe(2_200);

      // --- 4. the consumer re-subscribed -----------------------------------
      await poll(
        async () => {
          const health = await mockHealth();
          return health.subscribers >= beforeHealth.subscribers ? health : null;
        },
        { timeout: RECOVERY_TIMEOUT, interval: 250, label: 'worker reconnected to the topic' },
      );

      // --- 5. exactly one cdc_events row per replay id ----------------------
      const events = await poll(
        async () => {
          const rows = (await cdcEvents()).filter((event) => ids.includes(event.record_id));
          return rows.length === 2 ? rows : null;
        },
        { timeout: RECOVERY_TIMEOUT, interval: 200, label: 'two cdc_events rows for the replayed ids' },
      );
      expect(events).toHaveLength(2);
      expect(new Set(events.map((event) => event.event_id)).size).toBe(2);
      expect(new Set(events.map((event) => event.replay_id))).toEqual(
        new Set([String(first.replayId), String(second.replayId)]),
      );
      expect(events.every((event) => event.status === 'applied')).toBe(true);
      expect(events.every((event) => event.channel === OPPORTUNITY_TOPIC)).toBe(true);
      // These events were published while the stream was down, so the measured
      // latency is genuinely positive (it includes the reconnect backoff).
      for (const event of events) {
        expect(event.latency_ms, `latency for replay ${event.replay_id}`).toBeGreaterThan(0);
        expect(event.latency_ms).toBeLessThan(RECOVERY_TIMEOUT);
        expect(event.processed_at).not.toBeNull();
        expect(event.error).toBeNull();
      }

      // --- 6. the checkpoint advanced past both replayed events ------------
      const advanced = await poll(
        async () => {
          const status = await syncStatus();
          const checkpoint = status.checkpoints.find(
            (entry) => entry.channel === OPPORTUNITY_TOPIC,
          );
          if (!checkpoint?.replay_id) return null;
          return BigInt(checkpoint.replay_id) >= BigInt(second.replayId) ? checkpoint : null;
        },
        { timeout: RECOVERY_TIMEOUT, interval: 200, label: 'checkpoint advanced past the replay' },
      );
      expect(BigInt(advanced.replay_id ?? '0')).toBeGreaterThan(beforeReplay);
      expect(advanced.status).not.toBe('error');

      // eslint-disable-next-line no-console
      console.log(
        `[e2e] recovery: replay ${beforeReplay} -> ${advanced.replay_id} ` +
          `(events ${first.replayId}, ${second.replayId}), ${events.length} rows, no duplicates`,
      );
    });
  },
);
