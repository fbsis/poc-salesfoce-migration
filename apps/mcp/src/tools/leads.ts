/**
 * Lead tools (CONTRACTS.md §8): list_leads, get_lead, search_leads,
 * update_lead_status.
 *
 * Leads use `status` (new | contacted | qualified | closed) and `source`
 * (landing_page | salesforce | manual) — never `stage`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Lead } from '@poc/core';
import type { ToolContext } from './context';
import {
  fieldLines,
  formatDate,
  listHeading,
  normalizeList,
  renderTable,
  runTool,
  unwrapEntity,
} from './shared';

const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'closed'] as const;
const LEAD_SOURCES = ['landing_page', 'salesforce', 'manual'] as const;

const statusSchema = z.enum(LEAD_STATUSES);
const sourceSchema = z.enum(LEAD_SOURCES);

const ID_DESCRIPTION = 'Lead id — either the local uuid or the Salesforce id (00Q...).';

const listOutputSchema = { data: z.array(z.unknown()), meta: z.record(z.unknown()) };
const entityOutputSchema = { data: z.record(z.unknown()) };

function leadDetail(lead: Lead): string {
  const message =
    typeof lead.message === 'string' && lead.message.length > 0
      ? lead.message.length > 140
        ? `${lead.message.slice(0, 139)}…`
        : lead.message
      : null;
  const lines = [
    lead.full_name,
    fieldLines([
      ['id', lead.id],
      ['salesforce id', lead.salesforce_id],
      ['email', lead.email],
      ['phone', lead.phone],
      ['company', lead.company],
      ['interest', lead.property_interest],
      ['status', lead.status],
      ['source', lead.source],
      ['consent', lead.consent ? `yes (${formatDate(lead.consent_at)})` : 'no'],
      ['created', formatDate(lead.created_at)],
    ]),
  ];
  if (message) lines.push(`message: ${message}`);
  return lines.join('\n');
}

function leadTable(leads: Lead[]): string {
  return renderTable(
    ['name', 'email', 'status', 'source', 'created'],
    leads.map((lead) => [
      lead.full_name,
      lead.email,
      lead.status,
      lead.source,
      formatDate(lead.created_at),
    ]),
  );
}

export function registerLeadTools(server: McpServer, ctx: ToolContext): string[] {
  const { crm } = ctx;

  server.registerTool(
    'list_leads',
    {
      title: 'List leads',
      description:
        'Returns a paginated page of leads as `{ data, meta }` (name, email, status, source, created date). ' +
        'Filter by `status` (new, contacted, qualified, closed), `source` (landing_page, salesforce, manual), a ' +
        'free-text `search`, and/or `created_since` (ISO date). Use it to work the lead queue, e.g. "show me all ' +
        'new website leads".',
      inputSchema: {
        status: statusSchema.optional().describe('Exact lead status filter.'),
        source: sourceSchema.optional().describe('Exact lead source filter (landing_page | salesforce | manual).'),
        search: z.string().min(1).max(200).optional().describe('Case-insensitive text matched against name, email or company.'),
        created_since: z.string().min(4).optional().describe('Only leads created on/after this ISO date (`YYYY-MM-DD`).'),
        limit: z.number().int().min(1).max(200).optional().describe('Page size, 1-200 (default 50).'),
        offset: z.number().int().min(0).optional().describe('Rows to skip (default 0).'),
      },
      outputSchema: listOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ status, source, search, created_since, limit, offset }) =>
      runTool(async () => {
        const pageLimit = limit ?? 50;
        const pageOffset = offset ?? 0;
        const payload = await crm.get('/api/crm/leads', {
          query: { status, source, search, created_since, limit: pageLimit, offset: pageOffset },
        });
        const { rows, meta } = normalizeList<Lead>(payload, { limit: pageLimit, offset: pageOffset });
        const table = leadTable(rows);
        return {
          text:
            `${listHeading('leads', meta, { status, source, search, created_since })}\n${table}` +
            (meta.total > rows.length ? `\nNext page: offset=${meta.offset + rows.length}` : ''),
          structured: { data: rows, meta: { ...meta } },
        };
      }),
  );

  server.registerTool(
    'get_lead',
    {
      title: 'Get lead',
      description:
        'Returns one lead as `{ data }`: contact details, company, property interest, status, source, consent and ' +
        'the message the lead submitted. Use it before qualifying or replying to a lead. The `id` accepts either ' +
        'the local uuid or the Salesforce id.',
      inputSchema: { id: z.string().min(1).describe(ID_DESCRIPTION) },
      outputSchema: entityOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ id }) =>
      runTool(async () => {
        const payload = await crm.get(`/api/crm/leads/${encodeURIComponent(id)}`);
        const lead = unwrapEntity<Lead>(payload);
        return { text: leadDetail(lead), structured: { data: lead } };
      }),
  );

  server.registerTool(
    'search_leads',
    {
      title: 'Search leads',
      description:
        'Free-text search over leads (name, email, company) returning a plain array in `{ data }`. Use it when a ' +
        'person says "I submitted the form" and you need to find their lead; use list_leads for paged browsing ' +
        'with metadata.',
      inputSchema: {
        term: z.string().min(1).max(200).describe('Text matched against full name, email and company.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max matches, 1-200 (default 20).'),
      },
      outputSchema: { data: z.array(z.unknown()) },
      annotations: { readOnlyHint: true },
    },
    async ({ term, limit }) =>
      runTool(async () => {
        const payload = await crm.get('/api/crm/leads', { query: { search: term, limit: limit ?? 20 } });
        const { rows } = normalizeList<Lead>(payload, { limit: limit ?? 20, offset: 0 });
        return {
          text: `${rows.length} lead(s) matching "${term}"\n${leadTable(rows)}`,
          structured: { data: rows },
        };
      }),
  );

  server.registerTool(
    'update_lead_status',
    {
      title: 'Update lead status',
      description:
        'Moves a lead to a new status (new → contacted → qualified → closed) and returns the updated lead in ' +
        '`{ data }`. This is the supported way to progress a lead: it is the only lead mutation exposed, it only ' +
        'touches `status`, and it is idempotent (setting the current status is a no-op). The `id` accepts either ' +
        'the local uuid or the Salesforce id.',
      inputSchema: {
        id: z.string().min(1).describe(ID_DESCRIPTION),
        status: statusSchema.describe('Target status: new | contacted | qualified | closed.'),
      },
      outputSchema: entityOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, status }) =>
      runTool(async () => {
        const payload = await crm.patch(`/api/crm/leads/${encodeURIComponent(id)}/status`, { status });
        const lead = unwrapEntity<Lead>(payload);
        return {
          text: `Lead ${lead.full_name} <${lead.email}> is now "${lead.status}" (id: ${lead.id})`,
          structured: { data: lead },
        };
      }),
  );

  return ['list_leads', 'get_lead', 'search_leads', 'update_lead_status'];
}
