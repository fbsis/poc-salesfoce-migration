/**
 * Offline tests for the MCP server: no live CRM API, no HTTP listener beyond an
 * ephemeral localhost port for the auth middleware.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import type { AddressInfo } from 'node:net';
import { CrmClient, CrmApiError } from '../src/crm-client';
import { buildMcpServer } from '../src/server';
import { createApp } from '../src/index';

const EXPECTED_TOOLS = [
  'list_accounts',
  'get_account',
  'search_accounts',
  'create_account',
  'update_account',
  'list_opportunities',
  'get_opportunity',
  'create_opportunity',
  'update_opportunity',
  'list_leads',
  'get_lead',
  'search_leads',
  'update_lead_status',
  'get_sales_summary',
  'get_opportunities_by_stage',
  'get_lead_summary',
  'get_sync_status',
];

function stubClient(fetchImpl: typeof fetch): CrmClient {
  return new CrmClient({ baseUrl: 'http://crm.test', token: 'api-token', fetchImpl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('tool registration', () => {
  it('registers exactly the 17 contract tools in order', () => {
    const { toolNames } = buildMcpServer({ crm: stubClient(async () => jsonResponse({})) });
    expect(toolNames).toHaveLength(17);
    expect(toolNames).toEqual(EXPECTED_TOOLS);
  });

  it('exposes tools/list metadata with titles, schemas and annotations', async () => {
    const { server } = buildMcpServer({ crm: stubClient(async () => jsonResponse({})) });
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    const names = Object.keys(registered);
    expect(names.sort()).toEqual([...EXPECTED_TOOLS].sort());

    const listAccounts = registered.list_accounts as {
      title?: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: { readOnlyHint?: boolean };
    };
    expect(listAccounts.title).toBe('List accounts');
    expect(listAccounts.description).toMatch(/paginated page of CRM accounts/);
    expect(listAccounts.inputSchema).toBeDefined();
    expect(listAccounts.annotations?.readOnlyHint).toBe(true);

    const updateLeadStatus = registered.update_lead_status as {
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
    };
    expect(updateLeadStatus.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });
});

describe('crm client', () => {
  it('sends the bearer token and maps API errors to CrmApiError', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'not_found', message: 'Account not found' } }, 404),
    );
    const crm = stubClient(fetchImpl as unknown as typeof fetch);

    await expect(crm.get('/api/crm/accounts/abc')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
      message: 'Account not found',
    });
    await expect(crm.get('/api/crm/accounts/abc')).rejects.toBeInstanceOf(CrmApiError);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://crm.test/api/crm/accounts/abc');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer api-token');
    expect(init.signal).toBeDefined();
  });

  it('reports an unreachable upstream without leaking internals', async () => {
    const crm = stubClient((async () => {
      throw new TypeError('fetch failed: ECONNREFUSED 10.0.0.1:3000');
    }) as unknown as typeof fetch);
    const failure = await crm.get('/api/crm/accounts').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CrmApiError);
    expect(failure).toMatchObject({ code: 'upstream_unreachable', status: 503 });
    expect((failure as CrmApiError).message).not.toMatch(/ECONNREFUSED/);
  });
});

/** Minimal JSON-RPC tools/call helper that drives the real server + client pair. */
async function callTool(
  server: ReturnType<typeof buildMcpServer>['server'],
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'vitest', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.callTool({ name, arguments: args })) as never;
  } finally {
    await client.close();
  }
}

describe('list_opportunities handler', () => {
  it('sends stage as a query parameter and formats the table', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            salesforce_id: '006000000000001',
            account_id: 'acc-1',
            name: 'Aurora Tower Phase 2',
            stage: 'Negotiation',
            amount: '125000.00',
            close_date: '2025-06-30',
            owner_name: 'Dana Reed',
            probability: 60,
            source: 'salesforce',
            salesforce_updated_at: '2025-01-02T03:04:05.000Z',
            synced_at: '2025-01-02T03:04:06.000Z',
            created_at: '2025-01-01T00:00:00.000Z',
            updated_at: '2025-01-02T03:04:05.000Z',
            account_name: 'Aurora Holdings',
          },
          {
            id: '22222222-2222-2222-2222-222222222222',
            salesforce_id: null,
            account_id: null,
            name: 'Harbor Point Renewal',
            stage: 'Negotiation',
            amount: '42000.00',
            close_date: null,
            owner_name: null,
            probability: null,
            source: 'local',
            salesforce_updated_at: null,
            synced_at: null,
            created_at: '2025-01-01T00:00:00.000Z',
            updated_at: '2025-01-02T00:00:00.000Z',
          },
        ],
        meta: { total: 12, limit: 50, offset: 0 },
      }),
    );
    const { server } = buildMcpServer({ crm: stubClient(fetchImpl as unknown as typeof fetch) });

    const result = await callTool(server, 'list_opportunities', { stage: 'Negotiation' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown as [URL])[0]));
    expect(url.pathname).toBe('/api/crm/opportunities');
    expect(url.searchParams.get('stage')).toBe('Negotiation');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('offset')).toBe('0');
    // Unset filters must not be sent as "undefined".
    expect(url.searchParams.has('search')).toBe(false);
    expect(url.searchParams.has('account_id')).toBe(false);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('12 opportunities (stage=Negotiation)');
    expect(text).toContain('name');
    expect(text).toContain('$amount');
    expect(text).toContain('close date');
    expect(text).toContain('Aurora Tower Phase 2');
    expect(text).toContain('$125,000.00');
    expect(text).toContain('2025-06-30');
    expect(text).toContain('…and 10 more');

    expect(result.structuredContent).toMatchObject({
      meta: { total: 12, limit: 50, offset: 0 },
    });
    expect((result.structuredContent as { data: unknown[] }).data).toHaveLength(2);
  });

  it('returns isError with "code: message" when the API fails', async () => {
    const fetchImpl = async () =>
      jsonResponse({ error: { code: 'validation_error', message: 'stage is invalid' } }, 400);
    const { server } = buildMcpServer({ crm: stubClient(fetchImpl as unknown as typeof fetch) });

    const result = await callTool(server, 'list_opportunities', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('validation_error: stage is invalid');
    expect(result.structuredContent).toBeUndefined();
  });
});

describe('auth middleware', () => {
  let server: import('node:http').Server | undefined;
  let app: Express | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server = undefined;
    });
    app = undefined;
  });

  async function listen(instance: Express): Promise<string> {
    server = instance.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  function appWithToken(token: string): Express {
    app = createApp({
      authToken: token,
      crm: stubClient(async () => jsonResponse({ data: [], meta: { total: 0, limit: 1, offset: 0 } })),
    });
    return app;
  }

  it('rejects /mcp without a bearer token', async () => {
    const base = await listen(appWithToken('poc-local-token'));
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('rejects /mcp with a wrong bearer token', async () => {
    const base = await listen(appWithToken('poc-local-token'));
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('lets a valid token through to the MCP transport', async () => {
    const base = await listen(appWithToken('poc-local-token'));
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer poc-local-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '0' },
        },
      }),
    });
    expect(res.status).not.toBe(401);
    expect(await res.text()).toContain('poc-crm-mcp');
  });

  it('leaves /health open', async () => {
    const base = await listen(appWithToken('poc-local-token'));
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'ok', tools: 17 });
  });
});
