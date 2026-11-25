/**
 * Route-handler tests: the handlers are plain functions over a `Request`, so
 * they are imported and invoked directly — no HTTP server involved.
 * Rows created here are deleted afterwards (shared POC database).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLead, query } from '@poc/core';
import {
  GET as listAccountsRoute,
  POST as createAccountRoute,
} from '../../app/api/crm/accounts/route';
import {
  GET as getAccountRoute,
  PATCH as patchAccountRoute,
} from '../../app/api/crm/accounts/[id]/route';
import { GET as listLeadsRoute } from '../../app/api/crm/leads/route';
import { PATCH as leadStatusRoute } from '../../app/api/crm/leads/[id]/status/route';

const TOKEN = 'route-test-token';
const BASE = 'http://localhost/api/crm';
const AUTH = { authorization: `Bearer ${TOKEN}` };

const createdAccountIds: string[] = [];
const createdLeadIds: string[] = [];

let previousToken: string | undefined;

beforeAll(() => {
  previousToken = process.env.CRM_API_TOKEN;
  process.env.CRM_API_TOKEN = TOKEN;
});

afterAll(async () => {
  if (createdAccountIds.length > 0) {
    await query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [createdAccountIds]);
  }
  if (createdLeadIds.length > 0) {
    await query('DELETE FROM leads WHERE id = ANY($1::uuid[])', [createdLeadIds]);
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
/** Static routes still declare a context in their signature (Next type check). */
const STATIC = { params: Promise.resolve({}) };

describe('GET /api/crm/accounts', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const response = await listAccountsRoute(get('/accounts', {}), STATIC);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'unauthorized' },
    });
  });

  it('returns the list envelope', async () => {
    const response = await listAccountsRoute(get('/accounts?limit=5&offset=0'), STATIC);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: unknown[];
      meta: { total: number; limit: number; offset: number };
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.limit).toBe(5);
    expect(body.meta.offset).toBe(0);
    expect(typeof body.meta.total).toBe('number');
  });

  it('filters by search', async () => {
    const response = await listAccountsRoute(
      get(`/accounts?search=${encodeURIComponent('zzz-no-such-account')}`),
      STATIC,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown[]; meta: { total: number } };
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  it('treats blank optional params as absent', async () => {
    const response = await listAccountsRoute(get('/accounts?search=&limit=&offset=&source='), STATIC);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { meta: { limit: number; offset: number } };
    expect(body.meta.limit).toBe(50);
    expect(body.meta.offset).toBe(0);
  });

  it('rejects an invalid limit with 400 and field details', async () => {
    const response = await listAccountsRoute(get('/accounts?limit=0'), STATIC);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details).toHaveProperty('limit');
  });
});

describe('POST /api/crm/accounts', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const response = await createAccountRoute(send('/accounts', 'POST', { name: 'Nope' }, {}), STATIC);
    expect(response.status).toBe(401);
  });

  it('rejects a body without a name with 400 + details.name', async () => {
    const response = await createAccountRoute(send('/accounts', 'POST', {}), STATIC);
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details?: Record<string, string> };
    };
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details?.name).toBeTruthy();
  });

  it('creates an account (201) readable through GET /accounts/[id] and PATCH', async () => {
    const createResponse = await createAccountRoute(
      send('/accounts', 'POST', {
        name: 'API Route Test Account',
        industry: 'Testing',
        billing_country: 'BR',
      }),
      STATIC,
    );
    expect(createResponse.status).toBe(201);

    const created = (await createResponse.json()) as {
      data: { id: string; name: string; source: string; salesforce_id: string | null };
    };
    createdAccountIds.push(created.data.id);
    expect(created.data.name).toBe('API Route Test Account');
    expect(created.data.source).toBe('local');
    expect(created.data.salesforce_id).toBeNull();

    const getResponse = await getAccountRoute(get(`/accounts/${created.data.id}`), idContext(created.data.id));
    expect(getResponse.status).toBe(200);
    expect(((await getResponse.json()) as { data: { id: string } }).data.id).toBe(created.data.id);

    const patchResponse = await patchAccountRoute(
      send(`/accounts/${created.data.id}`, 'PATCH', { industry: 'SaaS' }),
      idContext(created.data.id),
    );
    expect(patchResponse.status).toBe(200);
    const patched = (await patchResponse.json()) as { data: { industry: string | null; name: string } };
    expect(patched.data.industry).toBe('SaaS');
    expect(patched.data.name).toBe('API Route Test Account');
  });

  it('rejects an empty PATCH body with 400', async () => {
    const id = createdAccountIds[0];
    const response = await patchAccountRoute(send(`/accounts/${id}`, 'PATCH', {}), idContext(id));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'validation_error',
    );
  });

  it('returns 404 for an unknown id', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    const response = await getAccountRoute(get(`/accounts/${unknown}`), idContext(unknown));
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('returns 400 for malformed JSON', async () => {
    const response = await createAccountRoute(
      new Request(`${BASE}/accounts`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: '{"name":',
      }),
      STATIC,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'validation_error',
    );
  });
});

describe('PATCH /api/crm/leads/[id]/status', () => {
  async function seedLead(): Promise<string> {
    const lead = await createLead({
      full_name: 'API Route Lead',
      email: `api-route-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      source: 'manual',
    });
    createdLeadIds.push(lead.id);
    return lead.id;
  }

  it('updates the status', async () => {
    const id = await seedLead();
    const response = await leadStatusRoute(
      send(`/leads/${id}/status`, 'PATCH', { status: 'contacted' }),
      idContext(id),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string; status: string } };
    expect(body.data.id).toBe(id);
    expect(body.data.status).toBe('contacted');
  });

  it('rejects an invalid status with 400 + details.status', async () => {
    const id = await seedLead();
    const response = await leadStatusRoute(
      send(`/leads/${id}/status`, 'PATCH', { status: 'bogus' }),
      idContext(id),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details?: Record<string, string> };
    };
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details?.status).toBeTruthy();
  });

  it('returns 404 for an unknown lead', async () => {
    const unknown = '00000000-0000-4000-8000-000000000001';
    const response = await leadStatusRoute(
      send(`/leads/${unknown}/status`, 'PATCH', { status: 'qualified' }),
      idContext(unknown),
    );
    expect(response.status).toBe(404);
  });

  it('is visible through GET /api/crm/leads?status=qualified', async () => {
    const id = await seedLead();
    expect(
      (
        await leadStatusRoute(
          send(`/leads/${id}/status`, 'PATCH', { status: 'qualified' }),
          idContext(id),
        )
      ).status,
    ).toBe(200);

    const response = await listLeadsRoute(get('/leads?status=qualified&limit=200'), STATIC);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ id: string; status: string }>;
      meta: { limit: number };
    };
    expect(body.data.some((lead) => lead.id === id)).toBe(true);
    expect(body.data.every((lead) => lead.status === 'qualified')).toBe(true);
  });
});
