/**
 * Capability 5 — "An AI agent queries and manages CRM records through MCP".
 *
 * The MCP server is called exactly the way an agent does: Streamable HTTP
 * (`POST /mcp`), a JSON-RPC `initialize`, then `tools/list` / `tools/call`. The
 * data the tools return is cross-checked against the internal CRM API and the
 * server-rendered CRM pages, so the assertions cannot pass on a mock.
 *
 * Covered: the 17-tool contract surface, read tools (`get_sales_summary`,
 * `list_leads`), a write tool (`update_lead_status`) verified through both the
 * API and the HTML, and the two 401 paths (MCP without a token, CRM API
 * without a token). The lead's status is restored at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLead, type Lead, type SalesSummary } from '@poc/core';

import {
  WEB_URL,
  RUN,
  api,
  apiJson,
  callTool,
  cleanupE2EData,
  e2eEmail,
  e2eIp,
  mcp,
  mcpRequest,
  page,
  plainText,
} from './helpers';

interface Paged<T> {
  data: T[];
  meta: { total: number; limit: number; offset: number };
}

/** docs/CONTRACTS.md §8 — the exact tool surface, no more, no less. */
const CONTRACT_TOOLS = [
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
].sort();

const EMAIL = e2eEmail('lead');
const NAME = `E2E Lead ${RUN}`;

describe(
  'Capability 5 — an AI agent queries and manages CRM records through MCP',
  { timeout: 60_000 },
  () => {
    let leadId = '';
    let originalStatus = 'new';

    beforeAll(async () => {
      // Capability 4 creates this lead. If it already cleaned up (this file must
      // also run on its own), create it through the same public endpoint.
      const found = await apiJson<Paged<Lead>>(
        `/api/crm/leads?search=${encodeURIComponent(EMAIL)}&source=landing_page&limit=5`,
      );
      if (found.data.length > 0) {
        leadId = found.data[0].id;
        originalStatus = found.data[0].status;
      } else {
        const response = await fetch(`${WEB_URL}/api/leads`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': e2eIp('mcp') },
          body: JSON.stringify({
            full_name: NAME,
            email: EMAIL,
            property_interest: 'Two-bedroom condo near the waterfront',
            consent: true,
          }),
        });
        expect([200, 201, 429]).toContain(response.status);
        if (response.status === 200 || response.status === 201) {
          const body = (await response.json()) as { data: { id: string; status: string } };
          leadId = body.data.id;
          originalStatus = body.data.status;
        } else {
          // The public route is rate limited per email (2 submissions / 10 min,
          // docs/CONTRACTS.md §5) and capability 4 already used this address
          // twice. Create the same landing-page lead through the service the
          // route itself calls, so this file stays independent of execution
          // order and of the in-memory limiter.
          const created = await createLead({
            full_name: NAME,
            email: EMAIL,
            property_interest: 'Two-bedroom condo near the waterfront',
            source: 'landing_page',
            status: 'new',
            consent: true,
          });
          leadId = created.id;
          originalStatus = created.status;
        }
      }
      expect(leadId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(originalStatus).toBe('new');
    });

    afterAll(async () => {
      // Defensive: never leave the demo lead queue mutated.
      try {
        await api(`/api/crm/leads/${leadId}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: originalStatus }),
        });
      } catch {
        /* the row may already be gone */
      }
      await cleanupE2EData();
    });

    it('initializes and exposes exactly the 17 contract tools', async () => {
      const init = await mcp<{
        protocolVersion: string;
        serverInfo: { name: string; version: string };
        capabilities: { tools?: unknown };
      }>('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'poc-e2e', version: '1.0.0' },
      });

      expect(init.protocolVersion).toBe('2024-11-05');
      expect(init.serverInfo.name).toBe('poc-crm-mcp');
      expect(init.capabilities.tools).toBeTruthy();

      const listed = await mcp<{
        tools: Array<{
          name: string;
          description?: string;
          inputSchema?: { type?: string };
          annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
        }>;
      }>('tools/list');

      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toHaveLength(17);
      expect(names).toEqual(CONTRACT_TOOLS);
      expect(listed.tools.every((tool) => (tool.description ?? '').length > 20)).toBe(true);
      expect(listed.tools.every((tool) => typeof tool.annotations?.readOnlyHint === 'boolean')).toBe(
        true,
      );
      // Mutating tools must not be flagged destructive (contract §8).
      for (const name of ['create_account', 'update_account', 'create_opportunity', 'update_opportunity', 'update_lead_status']) {
        const tool = listed.tools.find((entry) => entry.name === name);
        expect(tool?.annotations?.destructiveHint, `${name}.destructiveHint`).toBe(false);
      }
    });

    it('returns sales numbers that match the CRM API', async () => {
      const tool = await callTool<SalesSummary>('get_sales_summary');
      const fromApi = await apiJson<{ data: SalesSummary }>('/api/crm/reports/sales-summary');

      expect(tool.data).toEqual(fromApi.data);
      expect(typeof tool.data.accounts).toBe('number');
      expect(tool.data.salesforceRecords).toBeGreaterThanOrEqual(11);
      expect(tool.data.leads).toBeGreaterThanOrEqual(1);
      // The human-readable content is what an LLM actually reads.
      expect(tool.text).toContain('Sales summary');
      expect(tool.text).toContain(String(tool.data.accounts));
    });

    it('finds the landing-page lead through list_leads (source=landing_page)', async () => {
      const result = await callTool<Lead[]>('list_leads', {
        source: 'landing_page',
        search: EMAIL,
        limit: 10,
      });

      expect(Array.isArray(result.data)).toBe(true);
      const lead = result.data.find((entry) => entry.email === EMAIL);
      expect(lead, `lead ${EMAIL} in list_leads output`).toBeDefined();
      expect(lead?.id).toBe(leadId);
      expect(lead?.full_name).toBe(NAME);
      expect(lead?.source).toBe('landing_page');
      expect(lead?.status).toBe('new');
      expect(Number(result.structuredContent?.meta?.total)).toBeGreaterThanOrEqual(1);
      expect(result.text).toContain(EMAIL);
    });

    it('moves the lead to contacted, visible in the API and in the rendered HTML', async () => {
      // Before: the detail page shows "New · current" on the active status button.
      const beforeHtml = plainText(await page(`/crm/leads/${leadId}`));
      expect(beforeHtml).toContain(`${NAME}`);
      expect(beforeHtml).toContain('New · current');

      const updated = await callTool<Lead>('update_lead_status', {
        id: leadId,
        status: 'contacted',
      });
      expect(updated.data.id).toBe(leadId);
      expect(updated.data.status).toBe('contacted');

      // Verified afterwards through the internal CRM API…
      const fetched = await apiJson<{ data: Lead }>(`/api/crm/leads/${leadId}`);
      expect(fetched.data.status).toBe('contacted');
      expect(fetched.data.updated_at).not.toBeUndefined();

      // …and through the server-rendered page (dynamic = 'force-dynamic').
      const afterHtml = plainText(await page(`/crm/leads/${leadId}`));
      expect(afterHtml).toContain('Contacted · current');
      expect(afterHtml).not.toContain('New · current');

      // A read tool sees the new status too (agent round trip).
      const readBack = await callTool<Lead>('get_lead', { id: leadId });
      expect(readBack.data.status).toBe('contacted');

      // Restore the demo lead queue.
      const restored = await apiJson<{ data: Lead }>(`/api/crm/leads/${leadId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: originalStatus }),
      });
      expect(restored.data.status).toBe('new');
      const restoredHtml = plainText(await page(`/crm/leads/${leadId}`));
      expect(restoredHtml).toContain('New · current');
    });

    it('rejects unauthenticated MCP and CRM API calls with 401', async () => {
      const mcpResponse = await mcpRequest('tools/list', {}, { token: null });
      expect(mcpResponse.status).toBe(401);
      expect((mcpResponse.json as { error?: { code?: string } } | null)?.error?.code).toBe(
        'unauthorized',
      );

      const wrongToken = await mcpRequest('tools/list', {}, { token: 'not-the-token' });
      expect(wrongToken.status).toBe(401);

      const crmResponse = await api('/api/crm/accounts?limit=1', { token: null });
      expect(crmResponse.status).toBe(401);
      const crmBody = (await crmResponse.json()) as { error: { code: string } };
      expect(crmBody.error.code).toBe('unauthorized');

      // Sanity: the same calls succeed with a token.
      const withToken = await api('/api/crm/accounts?limit=1');
      expect(withToken.status).toBe(200);
      const toolsWithToken = await mcpRequest('tools/list');
      expect(toolsWithToken.status).toBe(200);
    });
  },
);
