/**
 * Capability 1 — "Salesforce records are imported into the internal CRM"
 * (Bulk API 2.0).
 *
 * Proves the whole migration path against the live stack: the workspace mock
 * holds a known dataset, the worker runs a real Bulk API 2.0 query job per
 * object and upserts through `@poc/core`, and the CRM API serves the result
 * with `source='salesforce'`, the original Salesforce id and the relationships
 * intact. The second test proves the upsert is idempotent (no duplicate rows).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Account, Contact, Lead, Opportunity, SyncRun } from '@poc/core';

import {
  RUN,
  apiJson,
  bulkRun,
  cleanupE2EData,
  e2eIds,
  liveCounts,
  liveRecordCount,
  mockState,
  poll,
  prepareE2EDataset,
  workerHealth,
  type E2EIds,
} from './helpers';

interface Paged<T> {
  data: T[];
  meta: { total: number; limit: number; offset: number };
}

interface Single<T> {
  data: T;
}

interface BulkTotals {
  read: number;
  applied: number;
  skipped_stale: number;
  ignored: number;
  errors: number;
}

const TABLE_PATHS = ['accounts', 'contacts', 'opportunities', 'leads'] as const;

describe(
  'Capability 1 — Salesforce records are imported into the internal CRM (Bulk API 2.0)',
  { timeout: 60_000 },
  () => {
    let ids: E2EIds;
    /** Totals per object before the first run of the file. */
    let baseline: Record<(typeof TABLE_PATHS)[number], number>;

    beforeAll(async () => {
      ids = e2eIds(await prepareE2EDataset());
      baseline = await totals();
    });

    afterAll(async () => {
      await cleanupE2EData();
    });

    /** `meta.total` for each CRM collection (limit=1 keeps the payload tiny). */
    async function totals(): Promise<Record<(typeof TABLE_PATHS)[number], number>> {
      const entries = await Promise.all(
        TABLE_PATHS.map(async (table) => {
          const page = await apiJson<Paged<unknown>>(`/api/crm/${table}?limit=1`);
          return [table, page.meta.total] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<(typeof TABLE_PATHS)[number], number>;
    }

    /** Rows whose name/email/company mentions this run's marker. */
    async function byMarker<T>(table: (typeof TABLE_PATHS)[number]): Promise<Paged<T>> {
      return apiJson<Paged<T>>(`/api/crm/${table}?search=${RUN}&limit=200`);
    }

    it('imports every seeded record over a real Bulk API 2.0 job', async () => {
      const snapshot = await mockState();
      const expectedRead = liveRecordCount(snapshot.dataset);
      const expectedCounts = liveCounts(snapshot.dataset);
      // The mock holds the demo dataset *plus* this run's 11 objects.
      expect(expectedCounts.accounts).toBeGreaterThanOrEqual(3);
      expect(expectedCounts.contacts).toBeGreaterThanOrEqual(3);
      expect(expectedCounts.opportunities).toBeGreaterThanOrEqual(3);
      expect(expectedCounts.leads).toBeGreaterThanOrEqual(2);

      const run = await bulkRun();

      // --- the run itself -------------------------------------------------
      expect(run.status).toBe('success');
      expect(run.kind).toBe('bulk_extract');
      expect(run.totals.errors).toBe(0);
      expect(run.totals.read).toBe(expectedRead);
      // Every record is accounted for exactly once. `skipped_stale` can be > 0
      // for *demo* rows whose local copy was already advanced by CDC (the mock
      // was reseeded from its static fixture), which is the stale guard doing
      // its job — the 11 E2E rows below are all applied, which is asserted by
      // reading each one back with its seeded values.
      expect(run.totals.applied + run.totals.skipped_stale + run.totals.ignored).toBe(expectedRead);
      expect(run.totals.applied).toBeGreaterThanOrEqual(11);
      expect(run.totals.ignored).toBe(0);
      expect(run.objects.map((entry) => entry.object)).toEqual([
        'Account',
        'Contact',
        'Opportunity',
        'Lead',
      ]);
      expect(run.objects.every((entry) => entry.errors.length === 0)).toBe(true);

      // --- GET /health reports the completed run ---------------------------
      const health = await poll(
        async () => {
          const current = await workerHealth();
          const last = current.lastBulkRun;
          if (!last || last.syncRunId !== run.jobId) return null;
          return last.status === 'success' ? last : null;
        },
        { timeout: 15_000, label: 'worker /health reports the finished bulk run' },
      );
      expect(health.totals?.applied).toBe(run.totals.applied);
      expect(health.finishedAt).not.toBeNull();
      const worker = await workerHealth();
      expect(worker.status).toBe('ok');
      expect(['all', 'bulk', 'once', 'cdc', 'reconcile']).toContain(worker.mode);

      // --- sync_runs has the bulk_extract success row with the right counts
      const runs = await apiJson<Paged<SyncRun>>('/api/crm/sync/runs?limit=20');
      const recorded = runs.data.find((entry) => entry.id === run.jobId);
      expect(recorded, `sync_runs row for ${run.jobId}`).toBeDefined();
      expect(recorded?.kind).toBe('bulk_extract');
      expect(recorded?.status).toBe('success');
      expect(recorded?.records_read).toBe(expectedRead);
      expect(recorded?.records_written).toBe(run.totals.applied);
      expect(recorded?.finished_at).not.toBeNull();
      expect(recorded?.error).toBeNull();
      const totalsInDetails = (recorded?.details as { totals?: BulkTotals } | null)?.totals;
      expect(totalsInDetails?.errors).toBe(0);
      expect(totalsInDetails?.skipped_stale).toBe(run.totals.skipped_stale);
      expect((recorded?.records_written ?? 0) + (totalsInDetails?.skipped_stale ?? 0)).toBe(
        recorded?.records_read,
      );

      // --- accounts: source, Salesforce id, mapped fields ------------------
      const accounts: Account[] = [];
      for (const id of ids.accounts) {
        const { data } = await apiJson<Single<Account>>(`/api/crm/accounts/${id}`);
        accounts.push(data);
        expect(data.salesforce_id).toBe(id);
        expect(data.source).toBe('salesforce');
        expect(data.name).toBe(`E2E Account ${ids.accounts.indexOf(id) + 1} ${RUN}`);
        expect(data.industry).not.toBeNull();
        expect(data.billing_country).toBe('United States');
        expect(data.salesforce_updated_at).not.toBeNull();
        expect(data.synced_at).not.toBeNull();
      }

      // --- contacts: every one linked to its parent account ----------------
      for (const [index, id] of ids.contacts.entries()) {
        const { data } = await apiJson<Single<Contact>>(`/api/crm/contacts/${id}`);
        expect(data.salesforce_id).toBe(id);
        expect(data.source).toBe('salesforce');
        expect(data.last_name).toContain(RUN);
        expect(data.account_id).toBe(accounts[index].id);
        expect(data.account_name).toBe(accounts[index].name);
      }

      // --- opportunities: relationship + stage/amount mapped --------------
      for (const [index, id] of ids.opportunities.entries()) {
        const { data } = await apiJson<Single<Opportunity>>(`/api/crm/opportunities/${id}`);
        expect(data.salesforce_id).toBe(id);
        expect(data.source).toBe('salesforce');
        expect(data.account_id).toBe(accounts[index].id);
        expect(data.name).toContain(RUN);
        expect(['Prospecting', 'Proposal', 'Negotiation']).toContain(data.stage);
        expect(Number(data.amount)).toBe([120_000, 240_000, 360_000][index]);
        expect(data.close_date).toBe('2026-06-30');
        expect(data.probability).toBe([10, 60, 80][index]);
      }

      // --- leads: source is 'salesforce', Salesforce status mapped --------
      const statuses: string[] = [];
      for (const id of ids.leads) {
        const { data } = await apiJson<Single<Lead>>(`/api/crm/leads/${id}`);
        expect(data.salesforce_id).toBe(id);
        expect(data.source).toBe('salesforce');
        expect(data.full_name).toContain(RUN);
        statuses.push(data.status);
      }
      expect(statuses).toEqual(['new', 'contacted']);

      // --- exactly the seeded rows, all from Salesforce -------------------
      for (const [table, expected] of [
        ['accounts', 3],
        ['contacts', 3],
        ['opportunities', 3],
        ['leads', 2],
      ] as const) {
        const page = await byMarker<{ source: string }>(table);
        expect(page.meta.total, `${table} rows for ${RUN}`).toBe(expected);
        expect(page.data.every((row) => row.source === 'salesforce')).toBe(true);
      }

      // Nothing was lost: the totals grew by exactly the seeded rows.
      const after = await totals();
      expect(after.accounts - baseline.accounts).toBe(3);
      expect(after.contacts - baseline.contacts).toBe(3);
      expect(after.opportunities - baseline.opportunities).toBe(3);
      expect(after.leads - baseline.leads).toBe(2);
    });

    it('is idempotent: a second run leaves every count unchanged', async () => {
      const before = await totals();
      const snapshot = await mockState();
      const expectedRead = liveRecordCount(snapshot.dataset);

      const run = await bulkRun();

      expect(run.status).toBe('success');
      expect(run.totals.errors).toBe(0);
      expect(run.totals.read).toBe(expectedRead);
      // Upsert by salesforce_id: re-applied (equal SystemModstamp is accepted),
      // never inserted twice, never ignored, and never reported as an error.
      expect(run.totals.ignored).toBe(0);
      expect(run.totals.applied + run.totals.skipped_stale + run.totals.ignored).toBe(expectedRead);

      const after = await totals();
      expect(after).toEqual(before);

      // The E2E rows are still exactly one row each.
      const accounts = await byMarker<Account>('accounts');
      expect(accounts.meta.total).toBe(3);
      expect(new Set(accounts.data.map((row) => row.salesforce_id)).size).toBe(3);
    });
  },
);
