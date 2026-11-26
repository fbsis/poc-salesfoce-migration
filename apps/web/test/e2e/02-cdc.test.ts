/**
 * Capability 2 — "Salesforce changes are synchronized via CDC" (Pub/Sub gRPC).
 *
 * Every change below is a *real* Avro CDC event published over the real gRPC
 * Pub/Sub stream by `apps/salesforce-mock` and consumed by the running worker
 * (`WORKER_MODE=all`). Nothing is written to Postgres by the test itself: the
 * assertions read the CRM API and the CDC event log the consumer maintains.
 *
 * Covered: UPDATE (with measured latency), CREATE, DELETE, and the stale-write
 * guard (an event whose `SystemModstamp` is older than the stored row must not
 * regress it and must be recorded as `skipped_stale`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CdcEvent, Opportunity } from '@poc/core';

import {
  RUN,
  api,
  apiJson,
  bulkRun,
  cleanupE2EData,
  e2eId,
  e2eIds,
  emitCdc,
  poll,
  prepareE2EDataset,
  type E2EIds,
} from './helpers';

interface Single<T> {
  data: T;
}

interface Paged<T> {
  data: T[];
  meta: { total: number; limit: number; offset: number };
}

const APPLY_TIMEOUT = 15_000;

describe(
  'Capability 2 — Salesforce changes are synchronized via CDC (Pub/Sub gRPC)',
  { timeout: 60_000 },
  () => {
    let ids: E2EIds;
    let linkedAccountId: string;

    beforeAll(async () => {
      const dataset = await prepareE2EDataset();
      ids = e2eIds(dataset);
      // The CDC tests need the rows to exist locally; one bulk extract does it.
      const run = await bulkRun();
      expect(run.status).toBe('success');
      const account = await apiJson<Single<{ id: string }>>(`/api/crm/accounts/${ids.accounts[0]}`);
      linkedAccountId = account.data.id;
    });

    afterAll(async () => {
      await cleanupE2EData();
    });

    /** The CDC log row for a specific replay id (unique per event). */
    async function eventForReplay(replayId: number): Promise<CdcEvent> {
      return poll(
        async () => {
          const page = await apiJson<{ data: CdcEvent[] }>('/api/crm/sync/events?limit=200');
          const match = page.data.find((event) => event.event_id.endsWith(`:${replayId}`));
          // The row is inserted before the apply finishes; wait for a terminal
          // status so the assertions never race the consumer.
          if (!match || match.status === 'pending') return null;
          return match;
        },
        { timeout: APPLY_TIMEOUT, interval: 100, label: `cdc_events row for replay ${replayId}` },
      );
    }

    async function getOpportunity(salesforceId: string): Promise<Opportunity | null> {
      const response = await api(`/api/crm/opportunities/${salesforceId}`);
      if (response.status === 404) return null;
      const body = (await response.json()) as Single<Opportunity>;
      return body.data;
    }

    it('applies an UPDATE within 15s and records the measured latency', async () => {
      const salesforceId = ids.opportunities[0];
      const before = await getOpportunity(salesforceId);
      expect(before, `seeded opportunity ${salesforceId}`).not.toBeNull();
      expect(before?.stage).toBe('Prospecting');
      expect(Number(before?.amount)).toBe(120_000);

      const emitted = await emitCdc('Opportunity', 'UPDATE', {
        Id: salesforceId,
        Name: `E2E Opportunity 1 ${RUN} (updated by CDC)`,
        StageName: 'Negotiation',
        Amount: 424_242,
      });
      expect(emitted.ok).toBe(true);
      expect(emitted.topic).toBe('/data/OpportunityChangeEvent');

      const startedAt = Date.now();
      const updated = await poll(
        async () => {
          const row = await getOpportunity(salesforceId);
          return row && row.stage === 'Negotiation' && Number(row.amount) === 424_242 ? row : null;
        },
        { timeout: APPLY_TIMEOUT, interval: 100, label: 'CDC UPDATE reflected in the CRM API' },
      );
      const endToEndMs = Date.now() - startedAt;

      expect(updated.stage).toBe('Negotiation');
      expect(Number(updated.amount)).toBe(424_242);
      expect(updated.name).toContain('updated by CDC');
      expect(updated.salesforce_updated_at).not.toBeNull();
      expect(endToEndMs).toBeLessThan(APPLY_TIMEOUT);

      // The consumer's own bookkeeping: applied, with a measured latency.
      const event = await eventForReplay(emitted.replayId);
      expect(event.event_id).toBe(`${event.channel}:${emitted.replayId}`);
      expect(event.object_name).toBe('Opportunity');
      expect(event.record_id).toBe(salesforceId);
      expect(event.change_type).toBe('UPDATE');
      expect(event.status).toBe('applied');
      expect(event.replay_id).toBe(String(emitted.replayId));
      expect(event.processed_at).not.toBeNull();
      expect(event.error).toBeNull();
      // `latency_ms = now - ChangeEventHeader.commitTimestamp`, in whole ms.
      // The mock publishes with a strictly-increasing ms timestamp, so a
      // sub-millisecond apply legitimately records 0; capability 3 additionally
      // asserts a *positive* latency on events that had to wait for a replay.
      expect(typeof event.latency_ms).toBe('number');
      expect(event.latency_ms).toBeGreaterThanOrEqual(0);
      expect(event.latency_ms).toBeLessThan(APPLY_TIMEOUT);
      // Latency is measured from ChangeEventHeader.commitTimestamp, so it can
      // never be larger than the time the test itself measured.
      expect(Number(event.latency_ms)).toBeLessThanOrEqual(endToEndMs + 1_000);

      // eslint-disable-next-line no-console
      console.log(
        `[e2e] cdc UPDATE: end-to-end ${endToEndMs}ms, consumer latency ${event.latency_ms}ms`,
      );
    });

    it('applies a CREATE for a new opportunity (with its account link)', async () => {
      const salesforceId = e2eId('006', 'N1');
      const emitted = await emitCdc('Opportunity', 'CREATE', {
        Id: salesforceId,
        Name: `E2E CDC created ${RUN}`,
        AccountId: ids.accounts[0],
        StageName: 'Proposal',
        Amount: 9_000,
        CloseDate: '2026-12-31',
        Probability: 55,
      });

      const created = await poll(
        () => getOpportunity(salesforceId),
        { timeout: APPLY_TIMEOUT, interval: 100, label: 'CDC CREATE visible in the CRM API' },
      );
      expect(created.salesforce_id).toBe(salesforceId);
      expect(created.source).toBe('salesforce');
      expect(created.name).toBe(`E2E CDC created ${RUN}`);
      expect(created.stage).toBe('Proposal');
      expect(Number(created.amount)).toBe(9_000);
      expect(created.account_id).toBe(linkedAccountId);
      expect(created.probability).toBe(55);

      const event = await eventForReplay(emitted.replayId);
      expect(event.change_type).toBe('CREATE');
      expect(event.status).toBe('applied');
    });

    it('applies a DELETE and removes the row', async () => {
      // Delete the opportunity created above (DELETE is idempotent on the
      // Salesforce side, but a missing row would be `ignored`, so reuse it).
      const salesforceId = e2eId('006', 'N1');
      const existing = await getOpportunity(salesforceId);
      expect(existing).not.toBeNull();

      const emitted = await emitCdc('Opportunity', 'DELETE', { Id: salesforceId });
      expect(emitted.changeType).toBe('DELETE');

      await poll(
        async () => ((await getOpportunity(salesforceId)) === null ? true : null),
        { timeout: APPLY_TIMEOUT, interval: 100, label: 'CDC DELETE removed the row' },
      );

      const event = await eventForReplay(emitted.replayId);
      expect(event.change_type).toBe('DELETE');
      expect(event.status).toBe('applied');
      expect(event.record_id).toBe(salesforceId);
    });

    it('does not regress a row when an older SystemModstamp arrives (stale guard)', async () => {
      // Idempotency check first: the created-then-deleted row stays gone.
      expect(await getOpportunity(e2eId('006', 'N1'))).toBeNull();

      const salesforceId = ids.opportunities[1];
      const before = await getOpportunity(salesforceId);
      expect(before, `seeded opportunity ${salesforceId}`).not.toBeNull();
      expect(before?.stage).toBe('Proposal');
      expect(Number(before?.amount)).toBe(240_000);

      // The mock honours an explicitly pinned SystemModstamp, so this event
      // really is *older* than the stored row (2024 < the bulk extract stamp).
      const staleStamp = '2024-01-01T00:00:00.000Z';
      const emitted = await emitCdc('Opportunity', 'UPDATE', {
        Id: salesforceId,
        Name: `${before?.name ?? 'E2E'} (stale attempt)`,
        StageName: 'Closed Lost',
        Amount: 1,
        SystemModstamp: staleStamp,
      });

      const event = await eventForReplay(emitted.replayId);
      expect(event.status).toBe('skipped_stale');
      expect(event.change_type).toBe('UPDATE');
      expect(event.record_id).toBe(salesforceId);

      // The row did not regress — name, stage, amount and updated_at hold.
      const after = await getOpportunity(salesforceId);
      expect(after).not.toBeNull();
      expect(after?.name).toBe(before?.name);
      expect(after?.stage).toBe('Proposal');
      expect(Number(after?.amount)).toBe(240_000);
      expect(after?.updated_at).toBe(before?.updated_at);
    });

    it('keeps one cdc_events row per replay id (dedupe key)', async () => {
      const page = await apiJson<Paged<CdcEvent>>('/api/crm/sync/events?limit=200');
      const ours = page.data.filter((event) => event.record_id.includes(`E2E${RUN}`));
      expect(ours.length).toBeGreaterThanOrEqual(4);
      const ids_ = ours.map((event) => event.event_id);
      expect(new Set(ids_).size).toBe(ids_.length);
      expect(ours.every((event) => event.status !== 'pending')).toBe(true);
    });
  },
);
