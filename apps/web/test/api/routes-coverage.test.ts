/**
 * Route-handler coverage for the CRM endpoints that had none (AUDIT P2-6):
 * contacts (list/get/create/patch), opportunities (list with `stage`, get,
 * create, patch), the three reports and the three sync routes — plus the
 * `limit` clamping rule (AUDIT P2-4).
 *
 * Same approach as `routes.test.ts`: the exported handlers are called directly
 * with a `Request`, no HTTP server involved. `routes.test.ts` is left untouched;
 * every row created here is deleted in `afterAll` (shared POC database).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount, query } from '@poc/core';
import { MAX_LIMIT } from '../../lib/api/schemas';
import {
  GET as listContactsRoute,
  POST as createContactRoute,
} from '../../app/api/crm/contacts/route';
import {
  GET as getContactRoute,
  PATCH as patchContactRoute,
} from '../../app/api/crm/contacts/[id]/route';
import {
  GET as listOpportunitiesRoute,
  POST as createOpportunityRoute,
} from '../../app/api/crm/opportunities/route';
import {
  GET as getOpportunityRoute,
  PATCH as patchOpportunityRoute,
} from '../../app/api/crm/opportunities/[id]/route';
import { GET as leadSummaryRoute } from '../../app/api/crm/reports/lead-summary/route';
import { GET as opportunitiesByStageRoute } from '../../app/api/crm/reports/opportunities-by-stage/route';
import { GET as salesSummaryRoute } from '../../app/api/crm/reports/sales-summary/route';
import { GET as syncEventsRoute } from '../../app/api/crm/sync/events/route';
import { GET as syncRunsRoute } from '../../app/api/crm/sync/runs/route';
import { GET as syncStatusRoute } from '../../app/api/crm/sync/status/route';

const TOKEN = 'routes-coverage-token';
const BASE = 'http://localhost/api/crm';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000ff';

const createdAccountIds: string[] = [];
const createdContactIds: string[] = [];
const createdOpportunityIds: string[] = [];
const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let previousToken: string | undefined;

beforeAll(() => {
  previousToken = process.env.CRM_API_TOKEN;
  process.env.CRM_API_TOKEN = TOKEN;
});

afterAll(async () => {
  // Children before parents (account_id is ON DELETE SET NULL, but be explicit).
  if (createdOpportunityIds.length > 0) {
    await query('DELETE FROM opportunities WHERE id = ANY($1::uuid[])', [createdOpportunityIds]);
  }
  if (createdContactIds.length > 0) {
    await query('DELETE FROM contacts WHERE id = ANY($1::uuid[])', [createdContactIds]);
  }
  if (createdAccountIds.length > 0) {
    await query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [createdAccountIds]);
  }
  if (previousToken === undefined) delete process.env.CRM_API_TOKEN;
  else process.env.CRM_API_TOKEN = previousToken;
});

function get(path: string, headers: Record<string, string> = AUTH): Request {
  return new Request(`${BASE}${path}`, { headers });
}

function send(
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
  headers: Record<string, string> = AUTH,
): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const idContext = (id: string) => ({ params: Promise.resolve({ id }) });
/** Static routes still declare a context parameter (Next type check). */
const STATIC = { params: Promise.resolve({}) };

type Paged<T> = { data: T[]; meta: { total: number; limit: number; offset: number } };
type Single<T> = { data: T };
type ErrorBody = { error: { code: string; message: string; details?: Record<string, string> } };

async function seedAccount(): Promise<string> {
  const account = await createAccount({ name: `Coverage Account ${run}`, industry: 'Testing' });
  createdAccountIds.push(account.id);
  return account.id;
}

// ------------------------------------------------------------------ contacts

describe('contacts routes', () => {
  let accountId: string;
  let contactId: string;

  beforeAll(async () => {
    accountId = await seedAccount();
  });

  it('GET /contacts rejects an unauthenticated request with 401', async () => {
    const response = await listContactsRoute(get('/contacts', {}), STATIC);
    expect(response.status).toBe(401);
    expect(((await response.json()) as ErrorBody).error.code).toBe('unauthorized');
  });

  it('GET /contacts returns the list envelope', async () => {
    const response = await listContactsRoute(get('/contacts?limit=5&offset=0'), STATIC);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Paged<unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.limit).toBe(5);
    expect(body.meta.offset).toBe(0);
    expect(typeof body.meta.total).toBe('number');
  });

  it('GET /contacts filters by search and by account_id', async () => {
    const none = await listContactsRoute(
      get(`/contacts?search=${encodeURIComponent('zzz-no-such-contact')}`),
      STATIC,
    );
    expect(none.status).toBe(200);
    const noneBody = (await none.json()) as Paged<unknown>;
    expect(noneBody.data).toEqual([]);
    expect(noneBody.meta.total).toBe(0);

    const byAccount = await listContactsRoute(get(`/contacts?account_id=${accountId}`), STATIC);
    expect(byAccount.status).toBe(200);
    const byAccountBody = (await byAccount.json()) as Paged<{ account_id: string }>;
    expect(byAccountBody.data.every((row) => row.account_id === accountId)).toBe(true);
  });

  it('POST /contacts rejects a body with no name and no email with 400', async () => {
    const response = await createContactRoute(send('/contacts', 'POST', {}), STATIC);
    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details).toBeTruthy();
  });

  it('POST /contacts creates a contact (201) and GET/PATCH /contacts/[id] read it back', async () => {
    const created = await createContactRoute(
      send('/contacts', 'POST', {
        first_name: 'Ada',
        last_name: `Coverage ${run}`,
        email: `coverage-${run}@example.com`,
        title: 'Engineer',
        account_id: accountId,
      }),
      STATIC,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Single<{
      id: string;
      first_name: string;
      last_name: string;
      account_id: string | null;
      source: string;
    }>;
    contactId = createdBody.data.id;
    createdContactIds.push(contactId);
    expect(createdBody.data.first_name).toBe('Ada');
    expect(createdBody.data.account_id).toBe(accountId);
    expect(createdBody.data.source).toBe('local');

    const fetched = await getContactRoute(get(`/contacts/${contactId}`), idContext(contactId));
    expect(fetched.status).toBe(200);
    const fetchedBody = (await fetched.json()) as Single<{ id: string }>;
    expect(fetchedBody.data.id).toBe(contactId);

    const patched = await patchContactRoute(
      send(`/contacts/${contactId}`, 'PATCH', { title: 'Staff Engineer' }),
      idContext(contactId),
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as Single<{ title: string | null; last_name: string | null }>;
    expect(patchedBody.data.title).toBe('Staff Engineer');
    expect(patchedBody.data.last_name).toBe(`Coverage ${run}`);
  });

  it('PATCH /contacts/[id] rejects an empty body with 400', async () => {
    expect(contactId).toBeTypeOf('string');
    const response = await patchContactRoute(
      send(`/contacts/${contactId}`, 'PATCH', {}),
      idContext(contactId),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorBody).error.code).toBe('validation_error');
  });

  it('GET/PATCH /contacts/[id] return 404 for an unknown id', async () => {
    const fetched = await getContactRoute(get(`/contacts/${UNKNOWN_ID}`), idContext(UNKNOWN_ID));
    expect(fetched.status).toBe(404);
    expect(((await fetched.json()) as ErrorBody).error.code).toBe('not_found');

    const patched = await patchContactRoute(
      send(`/contacts/${UNKNOWN_ID}`, 'PATCH', { title: 'Nope' }),
      idContext(UNKNOWN_ID),
    );
    expect(patched.status).toBe(404);
  });
});

// ------------------------------------------------------------- opportunities

describe('opportunities routes', () => {
  let accountId: string;
  let opportunityId: string;

  beforeAll(async () => {
    accountId = await seedAccount();
  });

  it('GET /opportunities rejects an unauthenticated request with 401', async () => {
    const response = await listOpportunitiesRoute(get('/opportunities', {}), STATIC);
    expect(response.status).toBe(401);
  });

  it('GET /opportunities returns the list envelope', async () => {
    const response = await listOpportunitiesRoute(get('/opportunities?limit=3'), STATIC);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Paged<unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.limit).toBe(3);
    expect(body.data.length).toBeLessThanOrEqual(3);
  });

  it('POST /opportunities requires a name', async () => {
    const response = await createOpportunityRoute(send('/opportunities', 'POST', {}), STATIC);
    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details?.name).toBeTruthy();
  });

  it('POST /opportunities creates one (201) and GET /opportunities/[id] reads it back', async () => {
    const created = await createOpportunityRoute(
      send('/opportunities', 'POST', {
        name: `Coverage Deal ${run}`,
        account_id: accountId,
        stage: 'Proposal',
        amount: '1234.50',
        close_date: '2030-06-30',
      }),
      STATIC,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Single<{
      id: string;
      name: string;
      stage: string;
      amount: string;
      close_date: string | null;
      account_id: string | null;
    }>;
    opportunityId = createdBody.data.id;
    createdOpportunityIds.push(opportunityId);
    expect(createdBody.data.stage).toBe('Proposal');
    expect(createdBody.data.account_id).toBe(accountId);
    expect(createdBody.data.close_date).toBe('2030-06-30');
    expect(Number(createdBody.data.amount)).toBe(1234.5);

    const fetched = await getOpportunityRoute(
      get(`/opportunities/${opportunityId}`),
      idContext(opportunityId),
    );
    expect(fetched.status).toBe(200);
    const fetchedBody = (await fetched.json()) as Single<{ id: string; stage: string }>;
    expect(fetchedBody.data.id).toBe(opportunityId);
    expect(fetchedBody.data.stage).toBe('Proposal');
  });

  it('GET /opportunities?stage= filters by stage and includes the new row', async () => {
    expect(opportunityId).toBeTypeOf('string');
    const response = await listOpportunitiesRoute(
      get(`/opportunities?stage=Proposal&limit=${MAX_LIMIT}`),
      STATIC,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Paged<{ id: string; stage: string }>;
    expect(body.data.every((row) => row.stage === 'Proposal')).toBe(true);
    expect(body.data.some((row) => row.id === opportunityId)).toBe(true);
    expect(body.meta.limit).toBe(MAX_LIMIT);
  });

  it('GET /opportunities rejects an unknown stage with 400', async () => {
    const response = await listOpportunitiesRoute(get('/opportunities?stage=Bogus'), STATIC);
    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details?.stage).toBeTruthy();
  });

  it('PATCH /opportunities/[id] updates stage and amount', async () => {
    expect(opportunityId).toBeTypeOf('string');
    const response = await patchOpportunityRoute(
      send(`/opportunities/${opportunityId}`, 'PATCH', { stage: 'Negotiation', amount: '2000' }),
      idContext(opportunityId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Single<{ stage: string; amount: string; name: string }>;
    expect(body.data.stage).toBe('Negotiation');
    expect(Number(body.data.amount)).toBe(2000);
    expect(body.data.name).toBe(`Coverage Deal ${run}`);
  });

  it('PATCH /opportunities/[id] rejects an empty body and an unknown id', async () => {
    const empty = await patchOpportunityRoute(
      send(`/opportunities/${opportunityId}`, 'PATCH', {}),
      idContext(opportunityId),
    );
    expect(empty.status).toBe(400);

    const missing = await patchOpportunityRoute(
      send(`/opportunities/${UNKNOWN_ID}`, 'PATCH', { stage: 'Closed Won' }),
      idContext(UNKNOWN_ID),
    );
    expect(missing.status).toBe(404);

    const missingGet = await getOpportunityRoute(
      get(`/opportunities/${UNKNOWN_ID}`),
      idContext(UNKNOWN_ID),
    );
    expect(missingGet.status).toBe(404);
  });
});

// -------------------------------------------------------------------- limits

describe('limit clamping (P2-4)', () => {
  it('clamps limit above the maximum instead of returning 400', async () => {
    const response = await listOpportunitiesRoute(get('/opportunities?limit=100000'), STATIC);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Paged<unknown>;
    expect(body.meta.limit).toBe(MAX_LIMIT);
    expect(MAX_LIMIT).toBe(200);
  });

  it('clamps on the sync runs collection too', async () => {
    const response = await syncRunsRoute(get('/sync/runs?limit=9999'), STATIC);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Single<unknown[]>;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeLessThanOrEqual(MAX_LIMIT);
  });

  it('still rejects a non-numeric or out-of-range limit with 400', async () => {
    for (const limit of ['abc', '0', '-5']) {
      const response = await listOpportunitiesRoute(get(`/opportunities?limit=${limit}`), STATIC);
      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorBody;
      expect(body.error.code).toBe('validation_error');
      expect(body.error.details?.limit).toBeTruthy();
    }
  });
});

// ------------------------------------------------------------------- reports

describe('report routes', () => {
  it('GET /reports/lead-summary returns totals, breakdowns and latest', async () => {
    const response = await leadSummaryRoute(get('/reports/lead-summary'), STATIC);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Single<{
      total: number;
      byStatus: Array<{ status: string; count: number }>;
      bySource: Array<{ source: string; count: number }>;
      newToday: number;
      latest: Array<{ id: string }>;
    }>;
    expect(typeof body.data.total).toBe('number');
    expect(body.data.total).toBeGreaterThanOrEqual(0);
    expect(body.data.byStatus.length).toBeGreaterThan(0);
    expect(body.data.bySource.length).toBeGreaterThan(0);
    expect(typeof body.data.newToday).toBe('number');
    expect(Array.isArray(body.data.latest)).toBe(true);
    expect(body.data.latest.length).toBeLessThanOrEqual(5);
  });

  it('GET /reports/lead-summary rejects an invalid since with 400', async () => {
    const response = await leadSummaryRoute(get('/reports/lead-summary?since=nope'), STATIC);
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorBody).error.code).toBe('validation_error');
  });

  it('GET /reports/opportunities-by-stage returns every stage with count and total', async () => {
    const response = await opportunitiesByStageRoute(
      get('/reports/opportunities-by-stage'),
      STATIC,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Single<
      Array<{ stage: string; count: number; totalAmount: number }>
    >;
    expect(body.data).toHaveLength(6);
    expect(body.data.map((row) => row.stage)).toEqual([
      'Prospecting',
      'Qualification',
      'Proposal',
      'Negotiation',
      'Closed Won',
      'Closed Lost',
    ]);
    for (const row of body.data) {
      expect(typeof row.count).toBe('number');
      expect(typeof row.totalAmount).toBe('number');
    }
  });

  it('GET /reports/sales-summary returns counters and money totals', async () => {
    const response = await salesSummaryRoute(get('/reports/sales-summary'), STATIC);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Single<Record<string, unknown>>;
    expect(body.data).toMatchObject({
      accounts: expect.any(Number),
      contacts: expect.any(Number),
      opportunities: expect.any(Number),
      leads: expect.any(Number),
      pipelineValue: expect.any(Number),
      wonValue: expect.any(Number),
      openOpportunities: expect.any(Number),
      newLeads: expect.any(Number),
      salesforceRecords: expect.any(Number),
      localRecords: expect.any(Number),
    });
  });

  it('reports reject an unauthenticated request with 401', async () => {
    for (const handler of [leadSummaryRoute, opportunitiesByStageRoute, salesSummaryRoute]) {
      const response = await handler(get('/reports/x', {}), STATIC);
      expect(response.status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------- sync

describe('sync routes', () => {
  it('GET /sync/events returns a non-paged collection, honouring limit and status', async () => {
    const response = await syncEventsRoute(get('/sync/events?limit=5'), STATIC);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Single<Array<{ id: number; status: string }>>;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeLessThanOrEqual(5);

    const applied = await syncEventsRoute(get('/sync/events?status=applied&limit=5'), STATIC);
    expect(applied.status).toBe(200);
    const appliedBody = (await applied.json()) as Single<Array<{ status: string }>>;
    expect(appliedBody.data.every((row) => row.status === 'applied')).toBe(true);
  });

  it('GET /sync/events rejects an unknown status and a bad limit with 400', async () => {
    const badStatus = await syncEventsRoute(get('/sync/events?status=bogus'), STATIC);
    expect(badStatus.status).toBe(400);
    expect(((await badStatus.json()) as ErrorBody).error.code).toBe('validation_error');

    const badLimit = await syncEventsRoute(get('/sync/events?limit=abc'), STATIC);
    expect(badLimit.status).toBe(400);
  });

  it('GET /sync/runs returns the recent runs', async () => {
    const response = await syncRunsRoute(get('/sync/runs?limit=3'), STATIC);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Single<
      Array<{ id: string; kind: string; status: string }>
    >;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeLessThanOrEqual(3);
    for (const row of body.data) {
      expect(['bulk_extract', 'cdc', 'reconcile']).toContain(row.kind);
      expect(['running', 'success', 'failed']).toContain(row.status);
    }
  });

  it('GET /sync/status returns the sync card payload', async () => {
    const response = await syncStatusRoute(get('/sync/status'), STATIC);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Single<{
      running: boolean;
      checkpoints: unknown[];
      counts: { cdcEvents: number; failedEvents: number; staleSkipped: number };
    }>;
    expect(typeof body.data.running).toBe('boolean');
    expect(Array.isArray(body.data.checkpoints)).toBe(true);
    expect(typeof body.data.counts.cdcEvents).toBe('number');
    expect(typeof body.data.counts.failedEvents).toBe('number');
    expect(typeof body.data.counts.staleSkipped).toBe('number');
  });

  it('sync routes reject an unauthenticated request with 401', async () => {
    for (const handler of [syncEventsRoute, syncRunsRoute, syncStatusRoute]) {
      const response = await handler(get('/sync/x', {}), STATIC);
      expect(response.status).toBe(401);
    }
  });
});
