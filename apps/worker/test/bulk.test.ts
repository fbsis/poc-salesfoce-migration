/**
 * Bulk API 2.0 extraction against the live mock + the real Postgres.
 *
 * Asserts the two things §7 requires: the mock dataset lands locally with the
 * right shape, and a second run does not duplicate anything.
 *
 * The assertions are written so that the demo `worker` container (which may be
 * running `all` in parallel) cannot make them flaky: they key on the mock's own
 * Salesforce ids instead of raw table totals.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, query, queryOne } from '@poc/core';
import { OBJECT_FIELDS, extractObject, runBulkExtract } from '@poc/salesforce';

import { mockState, setMockQueryPageJobSize } from './helpers';

const TABLES = ['accounts', 'contacts', 'opportunities', 'leads'] as const;
type Table = (typeof TABLES)[number];

const MOCK_PREFIXES: Record<Table, string> = {
  accounts: '001MOCK',
  contacts: '003MOCK',
  opportunities: '006MOCK',
  leads: '00QMOCK',
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

/** Remove only the mock dataset rows, so the insert can be proven again. */
async function purgeMockRows(): Promise<void> {
  for (const table of TABLES) {
    await query(`DELETE FROM ${table} WHERE salesforce_id LIKE '${MOCK_PREFIXES[table]}%'`);
  }
}

afterAll(async () => {
  await closePool();
});

describe('bulk extract (mock dataset → Postgres)', () => {
  it('reads every object over a real Bulk API 2.0 query job', async () => {
    const extracted = await extractObject('Opportunity', undefined);
    expect(extracted.object).toBe('Opportunity');
    expect(extracted.records.length).toBeGreaterThan(0);

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
      expect(ids.length).toBeGreaterThanOrEqual(2);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await setMockQueryPageJobSize(2000);
    }
  });

  it('inserts the mock dataset and is idempotent on a second run', async () => {
    const state = await mockState();
    // Soft-deleted records (IsDeleted) are kept by the mock but excluded from
    // every SOQL/Bulk result, so only live rows can be expected locally.
    const live = (rows: Array<Record<string, unknown>>) =>
      rows.filter((row) => row.IsDeleted !== true).map((row) => String(row.Id));
    const ids: Record<Table, string[]> = {
      accounts: live(state.dataset.accounts),
      contacts: live(state.dataset.contacts),
      opportunities: live(state.dataset.opportunities),
      leads: live(state.dataset.leads),
    };
    const expectedRead = TABLES.reduce((total, table) => total + ids[table].length, 0);

    await purgeMockRows();
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

    // Every live Salesforce id exists locally, marked as a Salesforce row.
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

    const skyline = state.dataset.opportunities.find(
      (row) => row.IsDeleted !== true && String(row.Name).includes('Downtown tower'),
    );
    if (skyline) {
      const row = await queryOne<{ stage: string; amount: string; owner_name: string | null }>(
        `SELECT stage, amount, owner_name FROM opportunities WHERE salesforce_id = $1`,
        [String(skyline.Id)],
      );
      // Data-driven: the mock dataset may have been changed by a demo or a CDC
      // event, so compare against the mock's *current* value.
      expect(row?.stage).toBe(String(skyline.StageName));
      expect(Number(row?.amount)).toBe(Number(skyline.Amount));
      // `Owner.Name` arrives as a flattened CSV column and maps to owner_name.
      expect(row?.owner_name).toBe('Dana Whitfield');
    }

    // -------- second run: nothing new, nothing duplicated -------------------
    const afterFirst = await counts();
    const second = await runBulkExtract({ log: () => undefined });
    const afterSecond = await counts();

    expect(second.totals.errors).toBe(0);
    expect(second.totals.read).toBe(expectedRead);
    expect(delta(afterFirst, afterSecond)).toEqual({
      accounts: 0,
      contacts: 0,
      opportunities: 0,
      leads: 0,
    });
    expect(second.syncRunId).not.toBe(first.syncRunId);
    // Row counts only ever moved because of *our* purge + insert.
    expect(before.accounts).toBeLessThanOrEqual(afterFirst.accounts);
  });
});
