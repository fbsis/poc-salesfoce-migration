/**
 * Suite-wide fixture: restore the canonical demo state once, when the whole run
 * finishes.
 *
 * Why this exists
 * ---------------
 * The mock's dataset is in-memory *and* shared by every suite in the repo: the
 * worker tests emit CDC events into it (which mutate or soft-delete demo rows),
 * and the E2E tests seed their own records next to the demo ones. That is fine
 * while a file owns the dataset it asserts on, but it used to leave the demo
 * broken after `pnpm test` (docs/DEMO.md expects exactly 4/6/6/3 and no test
 * rows), and the *next* run inherited whatever the previous one left behind.
 *
 * So: each file seeds what it needs (see `apps/web/test/e2e/helpers.ts`), and
 * this hook — which vitest runs exactly once for the whole run, not per file —
 * puts the demo back:
 *
 *   1. `POST /mock/reset` + `POST /mock/seed` with the canonical dataset, and
 *      verify `/mock/health` reports `CANONICAL_COUNTS`;
 *   2. clear the CRM tables that mirror Salesforce (the documented reset in
 *      docs/DEMO.md "Reset between demos") so stale/drifted rows cannot survive
 *      the re-seed — landing-page leads, which never came from Salesforce, are
 *      kept, and the suite's own rows go with the rest;
 *   3. run one real Bulk API 2.0 extract so the CRM holds exactly the canonical
 *      dataset again (and prove it: 19 read, 19 applied, 0 stale, 0 errors);
 *   4. drop anything test-shaped that survived (E2E/VITEST/TEST rows and their
 *      `cdc_events`), plus the orphan links that lost their row.
 *
 * The restore is part of the contract, so a failure here fails the run instead
 * of silently leaving the demo in a half-restored state.
 */
import { closePool, query, queryOne } from '@poc/core';

import {
  CANONICAL_COUNTS,
  CANONICAL_RECORD_COUNT,
  TEST_ID_REGEX,
  TEST_LEAD_EMAIL_PATTERN,
  canonicalDataset,
} from './fixtures/canonical';

// Same defaults as the E2E helpers: compose service names (the suite runs in
// the `tools` container), overridable for a host-side run.
const HOST = (process.env.E2E_HOST ?? '').trim();
const serviceUrl = (name: string, port: number): string =>
  `http://${HOST === '' ? name : HOST}:${port}`;

const MOCK_URL = (process.env.E2E_MOCK_URL ?? serviceUrl('salesforce-mock', 4000)).replace(/\/+$/, '');
const WORKER_URL = (process.env.E2E_WORKER_CONTROL_URL ?? serviceUrl('worker', 3002)).replace(
  /\/+$/,
  '',
);
const CRM_TOKEN = (process.env.CRM_API_TOKEN ?? 'poc-local-token').trim();

const TABLE_PATHS = ['accounts', 'contacts', 'opportunities', 'leads'] as const;

interface HttpResponseError extends Error {
  status: number;
}

/**
 * HTTP call with transport-level retries.
 *
 * A transport failure (the stack hot-restarts on edits, the mock was just
 * `/mock/reset`) is retried; an HTTP error status is not — it is a real answer
 * and retrying it would only hide the failure behind a longer timeout.
 */
async function request(url: string, init: RequestInit = {}, attempts = 8): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(
        `${init.method ?? 'GET'} ${url} -> ${response.status}: ${text.slice(0, 400)}`,
      ) as HttpResponseError;
      error.status = response.status;
      throw error;
    }
    return text.trim() === '' ? null : (JSON.parse(text) as unknown);
  }
  throw lastError instanceof Error ? lastError : new Error(`${url} unreachable`);
}

const postJson = (url: string, body: unknown = {}): Promise<unknown> =>
  request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface MockHealth {
  dataset: Record<string, number>;
}

interface BulkSummary {
  jobId: string;
  status: 'success' | 'failed';
  totals: { read: number; applied: number; skipped_stale: number; ignored: number; errors: number };
  objects: Array<{ object: string; errors: Array<{ id: string; message: string }> }>;
}

/**
 * Deletes the CRM rows that mirror Salesforce, keeping local-only data.
 *
 * Docs/DEMO.md documents this exact reset for a live demo — including *why* it
 * has to be a delete rather than a re-extract: a re-seeded demo record carries
 * its original 2024 `SystemModstamp`, so the stale-write guard (correctly)
 * refuses to overwrite a local row a previous `/mock/emit` stamped with 2026.
 * Truncating first is what makes the restored state deterministic.
 */
async function truncateSalesforceMirror(): Promise<void> {
  await query(`DELETE FROM cdc_events`);
  // `cdc_checkpoints` is deliberately NOT cleared: it is not test data, and a
  // non-zero checkpoint for the Opportunity topic is what lets a consumer (or
  // `03-recovery.test.ts` running on its own) resume instead of re-reading the
  // ring buffer. Replay ids never go backwards, so the checkpoints stay valid.
  await query(`DELETE FROM sync_runs`);
  await query(`DELETE FROM opportunities`);
  await query(`DELETE FROM contacts`);
  await query(`DELETE FROM accounts`);
  // `landing_page` leads never came from Salesforce; anything else here does.
  await query(`DELETE FROM leads WHERE source <> 'landing_page'`);
  // Leads the public-form tests created are local-only, so drop them by marker.
  await query(`DELETE FROM leads WHERE lower(email) LIKE $1`, [TEST_LEAD_EMAIL_PATTERN]);
  // Links whose local row no longer exists cannot be resolved by the extract.
  await query(
    `DELETE FROM sf_orphan_links o
      WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = o.local_id)
        AND NOT EXISTS (SELECT 1 FROM opportunities p WHERE p.id = o.local_id)`,
  );
}

/** Belt and braces: no test-shaped row or event may survive the restore. */
async function dropTestRows(): Promise<void> {
  await query(`DELETE FROM cdc_events WHERE record_id ~ $1`, [TEST_ID_REGEX]);
  await query(`DELETE FROM sf_orphan_links WHERE account_salesforce_id ~ $1`, [TEST_ID_REGEX]);
  for (const table of TABLE_PATHS) {
    await query(`DELETE FROM ${table} WHERE salesforce_id ~ $1`, [TEST_ID_REGEX]);
  }
  await query(`DELETE FROM leads WHERE lower(email) LIKE $1`, [TEST_LEAD_EMAIL_PATTERN]);
}

async function restoreCanonicalDemoState(): Promise<void> {
  // 1. Mock: empty, then exactly the canonical dataset. `POST /mock/seed` is a
  //    replace (docs/CONTRACTS.md §6), so no row from this run can leak through.
  await postJson(`${MOCK_URL}/mock/reset`);
  // Page size is a `/mock/config` hook a test may have shrunk (to observe
  // locator paging); put the documented default back so the demo is not left
  // with a 2-row page size.
  await postJson(`${MOCK_URL}/mock/config`, { queryJobPageSize: 2000 });
  const seeded = (await postJson(`${MOCK_URL}/mock/seed`, canonicalDataset())) as {
    counts: Record<string, number>;
  };
  const health = (await request(`${MOCK_URL}/mock/health`)) as MockHealth;
  const objects = ['accounts', 'contacts', 'opportunities', 'leads'] as const;
  for (const object of objects) {
    if (
      health.dataset[object] !== CANONICAL_COUNTS[object] ||
      seeded.counts[object] !== CANONICAL_COUNTS[object]
    ) {
      throw new Error(
        `canonical mock seed did not take: ${object} expected ${CANONICAL_COUNTS[object]}, ` +
          `health reports ${health.dataset[object]}, seed returned ${seeded.counts[object]}`,
      );
    }
  }

  // 2. CRM: truncate the Salesforce mirror so the re-seed below cannot be
  //    blocked by a row an earlier run (correctly) advanced past the 2024 stamps.
  await truncateSalesforceMirror();

  // 3. One real extract restores the demo rows from the canonical mock.
  const run = (await request(`${WORKER_URL}/run/bulk`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CRM_TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  })) as BulkSummary;
  const detail = run.objects
    .flatMap((entry) => entry.errors.map((error) => `${entry.object} ${error.id}: ${error.message}`))
    .join('; ');

  // 4. Nothing test-shaped may outlive the restore (an interrupted file, or a
  //    CDC event applied while the tables were being truncated).
  await dropTestRows();

  if (
    run.status !== 'success' ||
    run.totals.errors !== 0 ||
    run.totals.read !== CANONICAL_RECORD_COUNT ||
    run.totals.applied !== CANONICAL_RECORD_COUNT ||
    run.totals.skipped_stale !== 0
  ) {
    throw new Error(
      `demo restore extract failed: ${JSON.stringify(run.totals)} ` +
        `(expected read/applied ${CANONICAL_RECORD_COUNT}, 0 stale)${detail ? ` — ${detail}` : ''}`,
    );
  }

  const remaining = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total
       FROM (SELECT salesforce_id AS id FROM accounts
             UNION ALL SELECT salesforce_id FROM contacts
             UNION ALL SELECT salesforce_id FROM opportunities
             UNION ALL SELECT salesforce_id FROM leads) rows
      WHERE id ~ $1`,
    [TEST_ID_REGEX],
  );
  if ((remaining?.total ?? 0) !== 0) {
    throw new Error(`demo restore left ${remaining?.total} test row(s) in Postgres`);
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  return async () => {
    try {
      await restoreCanonicalDemoState();
    } finally {
      await closePool();
    }
  };
}
