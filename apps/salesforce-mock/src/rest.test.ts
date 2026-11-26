/**
 * Mock-side contract test for **Bulk API 2.0 query jobs** (docs/AUDIT.md P0-1).
 *
 * The app is started in-process on an ephemeral port with the real seed
 * dataset, so these assertions describe the wire shape the worker client sees:
 *
 *  - `POST /jobs/query` takes the SOQL in the create body and answers a job that
 *    is already `UploadComplete` (no batch upload step, no `PATCH`);
 *  - `GET /jobs/query/:id` walks UploadComplete → InProgress → JobComplete;
 *  - `GET /jobs/query/:id/results` is CSV whose header is exactly the SELECT
 *    list (never `sf__Id`/`sf__Created`), pages at `queryJobPageSize` rows via
 *    `Sforce-Query-Locator`, and returns a header-only CSV for zero rows;
 *  - the retired ingest-shaped endpoints (`POST /jobs/ingest`,
 *    `PUT /jobs/query/:id/batches`) answer 404 instead of accepting the wrong
 *    shape, and the synchronous `/query?q=` endpoint keeps working.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRestApp, MAX_RESULT_PAGE_SIZE } from './rest';
import { seedStore } from './seed';
import { SalesforceStore, type StoredEvent } from './store';
import type { PubSubControl } from './grpc';

const API_VERSION = process.env.SF_API_VERSION ?? 'v62.0';
const TOKEN = process.env.SF_MOCK_ACCESS_TOKEN ?? 'mock-access-token';

/** Minimal Pub/Sub stand-in: the REST surface only needs counters. */
const pubsubStub: PubSubControl = {
  publish: (_event: StoredEvent) => ({ delivered: 0, queued: false }),
  disconnect: () => 0,
  subscriberCount: () => 0,
  reset: () => undefined,
  stop: async () => undefined,
};

const store = new SalesforceStore();
let server: Server;
let baseUrl = '';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

async function createQueryJob(soql: string): Promise<Response> {
  return fetch(`${baseUrl}/services/data/${API_VERSION}/jobs/query`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      operation: 'query',
      query: soql,
      contentType: 'CSV',
      columnDelimiter: ',',
      lineEnding: 'LF',
    }),
  });
}

async function pollJob(id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = (await (
      await fetch(`${baseUrl}/services/data/${API_VERSION}/jobs/query/${id}`, {
        headers: auth(),
      })
    ).json()) as Record<string, unknown>;
    if (status.state === 'JobComplete' || status.state === 'Failed') return status;
    await sleep(100);
  }
  throw new Error(`query job ${id} never reached a terminal state`);
}

async function createCompletedJob(soql: string): Promise<string> {
  const created = await createQueryJob(soql);
  expect(created.status).toBe(200);
  const job = (await created.json()) as { id: string; state: string };
  expect(job.state).toBe('UploadComplete');
  const status = await pollJob(job.id);
  expect(status.state).toBe('JobComplete');
  return job.id;
}

async function setPageSize(size: number): Promise<void> {
  const response = await fetch(`${baseUrl}/mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queryJobPageSize: size }),
  });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  seedStore(store);
  const app = createRestApp({ store, pubsub: pubsubStub });
  server = await new Promise<Server>((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await setPageSize(MAX_RESULT_PAGE_SIZE);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('bulk query jobs (real Bulk API 2.0 shape)', () => {
  it('creates a query job with the SOQL in the body and completes it', async () => {
    const created = await createQueryJob('SELECT Id, Name, Industry FROM Account');
    expect(created.status).toBe(200);
    const job = (await created.json()) as Record<string, unknown>;
    expect(job.operation).toBe('query');
    expect(job.object).toBe('Account');
    expect(job.state).toBe('UploadComplete');
    expect(job.jobType).toBe('V2Query');
    expect(job.columnDelimiter).toBe(',');
    expect(typeof job.createdDate).toBe('string');
    expect(typeof job.createdById).toBe('string');

    const id = String(job.id);
    const done = await pollJob(id);
    expect(done.state).toBe('JobComplete');
    expect(done.numberRecordsProcessed).toBe(4);
    expect(done.numberRecordsFailed).toBe(0);
    expect(done).toHaveProperty('retries');
    expect(done).toHaveProperty('totalProcessingTime');
  });

  it('serves results whose header is exactly the SELECT list', async () => {
    const id = await createCompletedJob('SELECT Id, Name, Industry FROM Account');
    const response = await fetch(
      `${baseUrl}/services/data/${API_VERSION}/jobs/query/${id}/results`,
      { headers: auth() },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('sforce-query-locator')).toBe('null');

    const lines = (await response.text()).trimEnd().split('\n');
    expect(lines[0]).toBe('Id,Name,Industry');
    expect(lines[0]).not.toContain('sf__');
    expect(lines.slice(1)).toHaveLength(4);
    // Every data line projects exactly three columns, `Id` first.
    for (const line of lines.slice(1)) {
      expect(line.split(',')).toHaveLength(3);
      expect(line.startsWith('001')).toBe(true);
    }
  });

  it('returns a header-only CSV when the query matches no rows', async () => {
    const id = await createCompletedJob(
      "SELECT Id, Name, Industry FROM Account WHERE Industry = 'No Such Industry'",
    );
    const response = await fetch(
      `${baseUrl}/services/data/${API_VERSION}/jobs/query/${id}/results`,
      { headers: auth() },
    );
    const body = await response.text();
    expect(body).toBe('Id,Name,Industry\n');
    expect(response.headers.get('sforce-numberofrecords')).toBe('0');
  });

  it('pages results with Sforce-Query-Locator', async () => {
    await setPageSize(2);
    try {
      const id = await createCompletedJob('SELECT Id, Name FROM Account');
      const url = `${baseUrl}/services/data/${API_VERSION}/jobs/query/${id}/results`;

      const first = await fetch(url, { headers: auth() });
      const firstBody = (await first.text()).trimEnd().split('\n');
      const locator = first.headers.get('sforce-query-locator');
      expect(locator).not.toBe('null');
      expect(locator).toBeTruthy();
      expect(firstBody[0]).toBe('Id,Name');
      expect(firstBody.slice(1)).toHaveLength(2);

      const second = await fetch(`${url}?locator=${encodeURIComponent(String(locator))}`, {
        headers: auth(),
      });
      const secondBody = (await second.text()).trimEnd().split('\n');
      expect(secondBody[0]).toBe('Id,Name');
      expect(secondBody.slice(1)).toHaveLength(2);
      expect(second.headers.get('sforce-query-locator')).toBe('null');

      const ids = [...firstBody.slice(1), ...secondBody.slice(1)].map((line) => line.split(',')[0]);
      expect(new Set(ids).size).toBe(4);

      const bad = await fetch(`${url}?locator=not-a-locator`, { headers: auth() });
      expect(bad.status).toBe(400);
    } finally {
      await setPageSize(MAX_RESULT_PAGE_SIZE);
    }
  });

  it('rejects the retired ingest-shaped flow', async () => {
    const id = await createCompletedJob('SELECT Id, Name FROM Account');

    const ingestCreate = await fetch(`${baseUrl}/services/data/${API_VERSION}/jobs/ingest`, {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ object: 'Account', operation: 'query', contentType: 'CSV' }),
    });
    expect(ingestCreate.status).toBe(404);

    const batchUpload = await fetch(
      `${baseUrl}/services/data/${API_VERSION}/jobs/query/${id}/batches`,
      {
        method: 'PUT',
        headers: auth({ 'content-type': 'text/csv' }),
        body: 'SELECT Id, Name FROM Account',
      },
    );
    expect(batchUpload.status).toBe(404);

    const oldResultsPath = await fetch(
      `${baseUrl}/services/data/${API_VERSION}/jobs/query/${id}/successfulResults`,
      { headers: auth() },
    );
    expect(oldResultsPath.status).toBe(404);
  });

  it('still serves the synchronous SOQL endpoint and the admin endpoints', async () => {
    const query = await fetch(
      `${baseUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent('SELECT Id, Name FROM Account LIMIT 2')}`,
      { headers: auth() },
    );
    expect(query.status).toBe(200);
    const body = (await query.json()) as { totalSize: number; done: boolean; records: unknown[] };
    expect(body.totalSize).toBe(2);
    expect(body.done).toBe(true);
    expect(body.records).toHaveLength(2);

    const health = await fetch(`${baseUrl}/mock/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    expect(healthBody.status).toBe('ok');
    expect(healthBody.queryJobPageSize).toBe(MAX_RESULT_PAGE_SIZE);

    const unauthorized = await fetch(`${baseUrl}/services/data/${API_VERSION}/jobs/query/nope`);
    expect(unauthorized.status).toBe(401);
  });
});
