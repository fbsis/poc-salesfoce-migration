/**
 * Bulk API 2.0 extraction against the live mock + the real Postgres.
 *
 * Asserts the two things §7 requires: the mock dataset lands locally with the
 * right shape, and a second run does not duplicate anything.
 *
 * Determinism: this file **owns** the mock dataset it asserts on. It replaces
 * the mock's rows with `bulkFixture()` in `beforeAll` and then only reads back
 * ids it created, so (a) no other suite's rows can change the expected counts and
 * (b) nothing another suite emitted — a demo row edited over CDC to an unmapped
 * stage, say — can turn the extract into an error. The demo dataset is restored
 * once per run by `apps/web/test/global-setup.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query, queryOne } from '@poc/core';
import { OBJECT_FIELDS, extractObject, runBulkExtract } from '@poc/salesforce';

import {
  BULK_FIXTURE_COUNTS,
  BULK_FIXTURE_IDS,
  BULK_FIXTURE_RECORD_COUNT,
  BULK_ID_PREFIX,
  bulkFixture,
} from './fixtures/bulk-dataset';
import { mockHealth, setMockQueryPageJobSize, seedMock } from './helpers';

const TABLES = ['accounts', 'contacts', 'opportunities', 'leads'] as const;
type Table = (typeof TABLES)[number];

/** Salesforce key prefixes of the fixture ids, per table. */
const FIXTURE_PREFIXES: Record<Table, string> = {
  accounts: '001',
  contacts: '003',
  opportunities: '006',
  leads: '00Q',
};

async function counts(): Promise<Record<Table, number>> {
  const result = {} as Record<Table, number>;
  for (const table of TABLES) {
    const row = await queryOne<{ total: number }>(`SELECT count(*)::int AS total FROM ${table}`);
    result[table] = row?.total ?? 0;
  }
  return result;
}

function delta(before: Record<Table, number>, after: Record<Table, number>): Record<Table, number> {
  const result = {} as Record<Table, number>;
  for (const table of TABLES) result[table] = after[table] - before[table];
  return result;
}

/**
 * Remove only this file's rows, so the insert can be proven again.
 *
 * Scoped to `VITESTBULK` on purpose: the worker CDC tests create their own
 * `VITEST…` rows, and a suite must not delete another suite's data either.
 */
async function purgeFixtureRows(): Promise<void> {
  for (const table of TABLES) {
    await query(`DELETE FROM ${table} WHERE salesforce_id LIKE $1`, [`${FIXTURE_PREFIXES[table]}${BULK_ID_PREFIX}%`]);
  }
}

beforeAll(async () => {
  // Replace the mock dataset: from here on, every record a query job returns is
  // one this file created. `mode` defaults to `replace` (docs/CONTRACTS.md §6).
  const seeded = await seedMock(bulkFixture());
  expect(seeded.counts).toEqual(BULK_FIXTURE_COUNTS);
  expect((await mockHealth()).dataset).toEqual(BULK_FIXTURE_COUNTS);
});

afterAll(async () => {
  await closePool();
});

describe('bulk extract (mock dataset → Postgres)', () => {
  it('reads every object over a real Bulk API 2.0 query job', async () => {
    const extracted = await extractObject('Opportunity', undefined);
    expect(extracted.object).toBe('Opportunity');
    expect(extracted.records.length).toBe(BULK_FIXTURE_COUNTS.opportunities);

    // A query job's CSV header is exactly the SELECT list — no `sf__Id`,
    // no `sf__Created` (those belong to ingest jobs). `Owner.Name` stays a
    // single flattened column.
    const [header] = extracted.raw.split(/\r?\n/);
    expect(header).not.toContain('sf__');
    expect(header).toBe(OBJECT_FIELDS.Opportunity.join(','));
    expect(header).toContain('Owner.Name');

    const first = extracted.records[0];
    expect(typeof first.Id).toBe('string');
    expect(String(first.Id)).toMatch(/^006/);
    expect(first).toHaveProperty('StageName');
    // `SystemModstamp` comes back as Salesforce rendered it, and every record
    // carries exactly the selected columns.
    expect(String(first.SystemModstamp)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+[+-]\d{4}$/);
    expect(Object.keys(first).sort()).toEqual([...OBJECT_FIELDS.Opportunity].sort());
  });

  it('concatenates every Sforce-Query-Locator page of a query job', async () => {
    // Shrink the mock's result page so a 4-account query needs several pages.
    await setMockQueryPageJobSize(2);
    try {
      const extracted = await extractObject('Account', undefined);
      const header = OBJECT_FIELDS.Account.join(',');
      const lines = extracted.raw.split(/\r?\n/).filter((line) => line !== '');

      // Each page repeats the header; more than one header means the client
      // followed the locator instead of stopping after the first page.
      const headerLines = lines.filter((line) => line === header);
      expect(headerLines.length).toBeGreaterThanOrEqual(2);
      expect(lines.length - headerLines.length).toBe(extracted.records.length);

      const ids = extracted.records.map((record) => String(record.Id));
      expect(ids.length).toBe(BULK_FIXTURE_COUNTS.accounts);
      expect(ids.sort()).toEqual([...BULK_FIXTURE_IDS.accounts].sort());
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await setMockQueryPageJobSize(2000);
    }
  });

  it('inserts the mock dataset and is idempotent on a second run', async () => {
    // The fixture is the whole dataset, so this is the exact expected read — no
    // filtering of "live" rows is needed (the fixture has no deleted records).
    const expectedRead = BULK_FIXTURE_RECORD_COUNT;
    const ids = BULK_FIXTURE_IDS;

    await purgeFixtureRows();
    const before = await counts();

    const first = await runBulkExtract({ log: () => undefined });
    expect(first.totals.errors).toBe(0);
    expect(first.totals.read).toBe(expectedRead);
    expect(first.totals.applied).toBe(expectedRead);
    expect(first.objects.map((entry) => entry.object)).toEqual([
      'Account',
      'Contact',
      'Opportunity',
      'Lead',
    ]);

    // Every fixture id exists locally, marked as a Salesforce row.
    for (const table of TABLES) {
      const row = await queryOne<{ total: number; salesforce: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE source = 'salesforce')::int AS salesforce
           FROM ${table} WHERE salesforce_id = ANY($1::text[])`,
        [ids[table]],
      );
      expect(row?.total).toBe(ids[table].length);
      expect(row?.salesforce).toBe(ids[table].length);
    }

    // The mapping is asserted against the fixture, not against the mock's
    // current state: the values are known here, so nothing can drift.
    const mapped = await queryOne<{ stage: string; amount: string; owner_name: string | null }>(
      `SELECT stage, amount, owner_name FROM opportunities WHERE salesforce_id = $1`,
      [ids.opportunities[0]],
    );
    expect(mapped?.stage).toBe('Prospecting');
    expect(Number(mapped?.amount)).toBe(120_000);
    // `Owner.Name` arrives as a flattened CSV column and maps to owner_name.
    expect(mapped?.owner_name).toBe('Dana Whitfield');

    // The run recorded its own `sync_runs` row with the same numbers.
    const recorded = await queryOne<{
      kind: string;
      status: string;
      records_read: number;
      records_written: number;
      error: string | null;
    }>(
      `SELECT kind, status, records_read, records_written, error FROM sync_runs WHERE id = $1`,
      [first.syncRunId],
    );
    expect(recorded?.kind).toBe('bulk_extract');
    expect(recorded?.status).toBe('success');
    expect(recorded?.records_read).toBe(expectedRead);
    expect(recorded?.records_written).toBe(expectedRead);
    expect(recorded?.error).toBeNull();

    // Row counts only ever moved by exactly the rows this file purged + inserted.
    const afterFirst = await counts();
    expect(delta(before, afterFirst)).toEqual({ ...BULK_FIXTURE_COUNTS });

    // -------- second run: nothing new, nothing duplicated -------------------
    const second = await runBulkExtract({ log: () => undefined });
    const afterSecond = await counts();

    expect(second.totals.errors).toBe(0);
    expect(second.totals.read).toBe(expectedRead);
    expect(second.totals.applied).toBe(expectedRead);
    expect(delta(afterFirst, afterSecond)).toEqual({
      accounts: 0,
      contacts: 0,
      opportunities: 0,
      leads: 0,
    });
    expect(second.syncRunId).not.toBe(first.syncRunId);

    // …and one row per id, not two.
    for (const table of TABLES) {
      const row = await queryOne<{ total: number }>(
        `SELECT count(*)::int AS total FROM ${table} WHERE salesforce_id = ANY($1::text[])`,
        [ids[table]],
      );
      expect(row?.total).toBe(ids[table].length);
    }
  });
});
