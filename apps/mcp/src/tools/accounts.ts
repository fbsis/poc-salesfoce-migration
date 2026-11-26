/**
 * Account tools (CONTRACTS.md §8): list_accounts, get_account,
 * search_accounts, create_account, update_account.
 *
 * Every call goes through the internal HTTP API — the MCP server never touches
 * SQL. Ids accept the local uuid *or* the Salesforce id (the API resolves both).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Account } from '@poc/core';
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

const ID_DESCRIPTION = 'Account id — either the local uuid or the Salesforce id (001...).';

const listOutputSchema = { data: z.array(z.unknown()), meta: z.record(z.unknown()) };
const entityOutputSchema = { data: z.record(z.unknown()) };

function accountDetail(account: Account): string {
  return [
    account.name,
    fieldLines([
      ['id', account.id],
      ['salesforce id', account.salesforce_id],
      ['source', account.source],
      ['industry', account.industry],
      ['website', account.website],
      ['country', account.billing_country],
      ['owner', account.owner_name],
      ['sf updated', formatDate(account.salesforce_updated_at)],
      ['updated', formatDate(account.updated_at)],
    ]),
  ].join('\n');
}

export function registerAccountTools(server: McpServer, ctx: ToolContext): string[] {
  const { crm } = ctx;

  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description:
        'Returns a paginated page of CRM accounts (companies) as `{ data, meta }`, newest-updated first, ' +
        'optionally filtered by a free-text `search` over the account name. Use it to browse or filter the ' +
        'account book. For a name lookup where you only want matches, prefer search_accounts.',
      inputSchema: {
        search: z.string().min(1).max(200).optional().describe('Case-insensitive text matched against the account name.'),
        limit: z.number().int().min(1).max(200).optional().describe('Page size, 1-200 (default 50).'),
        offset: z.number().int().min(0).optional().describe('Rows to skip (default 0).'),
      },
      outputSchema: listOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ search, limit, offset }) =>
      runTool(async () => {
        const pageLimit = limit ?? 50;
        const pageOffset = offset ?? 0;
        const payload = await crm.get('/api/crm/accounts', {
          query: { search, limit: pageLimit, offset: pageOffset },
        });
        const { rows, meta } = normalizeList<Account>(payload, { limit: pageLimit, offset: pageOffset });
        const table = renderTable(
          ['name', 'industry', 'country', 'source'],
          rows.map((account) => [account.name, account.industry, account.billing_country, account.source]),
          { total: meta.total },
        );
        return {
          text: `${listHeading('accounts', meta, { search })}\n${table}`,
          structured: { data: rows, meta: { ...meta } },
        };
      }),
  );

  server.registerTool(
    'get_account',
    {
      title: 'Get account',
      description:
        'Returns one account as `{ data }`. Use it after list_accounts/search_accounts when you need the full ' +
        'record (website, billing country, owner, Salesforce sync timestamps). The `id` accepts either the local ' +
        'uuid or the Salesforce id.',
      inputSchema: { id: z.string().min(1).describe(ID_DESCRIPTION) },
      outputSchema: entityOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ id }) =>
      runTool(async () => {
        const payload = await crm.get(`/api/crm/accounts/${encodeURIComponent(id)}`);
        const account = unwrapEntity<Account>(payload);
        return { text: accountDetail(account), structured: { data: account } };
      }),
  );

  server.registerTool(
    'search_accounts',
    {
      title: 'Search accounts',
      description:
        'Name search over accounts (`name ILIKE %term%`), ordered by name, returning a plain array in `{ data }`. ' +
        'Use it when resolving a company name to an id before creating an opportunity or contact; use ' +
        'list_accounts when you want pagination metadata.',
      inputSchema: {
        term: z.string().min(1).max(200).describe('Text to match against the account name (case-insensitive).'),
        limit: z.number().int().min(1).max(200).optional().describe('Max matches, 1-200 (default 20).'),
      },
      outputSchema: { data: z.array(z.unknown()) },
      annotations: { readOnlyHint: true },
    },
    async ({ term, limit }) =>
      runTool(async () => {
        const payload = await crm.get('/api/crm/accounts', { query: { search: term, limit: limit ?? 20 } });
        const { rows } = normalizeList<Account>(payload, { limit: limit ?? 20, offset: 0 });
        const table = renderTable(
          ['name', 'industry', 'country'],
          rows.map((account) => [account.name, account.industry, account.billing_country]),
          { total: rows.length },
        );
        return {
          text: `${rows.length} account(s) matching "${term}"\n${table}`,
          structured: { data: rows },
        };
      }),
  );

  server.registerTool(
    'create_account',
    {
      title: 'Create account',
      description:
        'Creates a local account (source `local`, no Salesforce id) and returns the stored record in `{ data }`. ' +
        'Use it for companies that exist only in this CRM; Salesforce-originated accounts arrive via sync. ' +
        '`name` is required and must be unique enough to identify the company.',
      inputSchema: {
        name: z.string().min(1).max(200).describe('Company name.'),
        industry: z.string().max(120).optional().describe('Industry label, free text.'),
        website: z.string().max(300).optional().describe('Website URL.'),
        billing_country: z.string().max(120).optional().describe('Billing country, free text.'),
        owner_name: z.string().max(120).optional().describe('Account owner (a person name).'),
      },
      outputSchema: entityOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) =>
      runTool(async () => {
        const payload = await crm.post('/api/crm/accounts', input);
        const account = unwrapEntity<Account>(payload);
        return {
          text:
            `Created account "${account.name}" (id: ${account.id})\n` +
            fieldLines([
              ['source', account.source],
              ['industry', account.industry],
              ['country', account.billing_country],
              ['owner', account.owner_name],
            ]),
          structured: { data: account },
        };
      }),
  );

  server.registerTool(
    'update_account',
    {
      title: 'Update account',
      description:
        'Partially updates an account and returns the updated record in `{ data }`. Only the fields you send are ' +
        'changed. The `id` accepts either the local uuid or the Salesforce id. Idempotent — sending the same ' +
        'values twice is safe.',
      inputSchema: {
        id: z.string().min(1).describe(ID_DESCRIPTION),
        name: z.string().min(1).max(200).optional().describe('New company name.'),
        industry: z.string().max(120).nullable().optional().describe('Industry label; null clears it.'),
        website: z.string().max(300).nullable().optional().describe('Website URL; null clears it.'),
        billing_country: z.string().max(120).nullable().optional().describe('Billing country; null clears it.'),
        owner_name: z.string().max(120).nullable().optional().describe('Account owner; null clears it.'),
      },
      outputSchema: entityOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, ...patch }) =>
      runTool(async () => {
        const payload = await crm.patch(`/api/crm/accounts/${encodeURIComponent(id)}`, patch);
        const account = unwrapEntity<Account>(payload);
        return {
          text: `Updated account "${account.name}" (id: ${account.id})\n${accountDetail(account)}`,
          structured: { data: account },
        };
      }),
  );

  return ['list_accounts', 'get_account', 'search_accounts', 'create_account', 'update_account'];
}
