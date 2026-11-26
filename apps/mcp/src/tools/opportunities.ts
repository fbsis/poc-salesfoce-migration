/**
 * Opportunity tools (CONTRACTS.md §8): list_opportunities, get_opportunity,
 * create_opportunity, update_opportunity.
 *
 * Opportunities use `stage` (not `status`) — the enum is fixed:
 * Prospecting | Qualification | Proposal | Negotiation | Closed Won | Closed Lost.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Opportunity } from '@poc/core';
import type { ToolContext } from './context';
import {
  fieldLines,
  formatDate,
  formatMoney,
  listHeading,
  normalizeList,
  renderTable,
  runTool,
  unwrapEntity,
} from './shared';

const STAGES = [
  'Prospecting',
  'Qualification',
  'Proposal',
  'Negotiation',
  'Closed Won',
  'Closed Lost',
] as const;

const stageSchema = z.enum(STAGES);

const ID_DESCRIPTION =
  'Opportunity id — either the local uuid or the Salesforce id (006...).';

const listOutputSchema = { data: z.array(z.unknown()), meta: z.record(z.unknown()) };
const entityOutputSchema = { data: z.record(z.unknown()) };

function opportunityDetail(opportunity: Opportunity): string {
  return [
    opportunity.name,
    fieldLines([
      ['id', opportunity.id],
      ['salesforce id', opportunity.salesforce_id],
      ['stage', opportunity.stage],
      ['amount', formatMoney(opportunity.amount)],
      ['close date', opportunity.close_date],
      ['account', opportunity.account_name ?? opportunity.account_id],
      ['owner', opportunity.owner_name],
      ['probability', opportunity.probability === null ? null : `${opportunity.probability}%`],
      ['source', opportunity.source],
      ['updated', formatDate(opportunity.updated_at)],
    ]),
  ].join('\n');
}

const createSchema = {
  name: z.string().min(1).max(200).describe('Opportunity name, e.g. "Aurora Tower — Phase 2".'),
  account_id: z.string().min(1).optional().describe('Owning account (local uuid or Salesforce id).'),
  stage: stageSchema.optional().describe('Pipeline stage (default Prospecting).'),
  amount: z.union([z.number(), z.string()]).optional().describe('Deal value in USD, e.g. 120000 or "120000.00".'),
  close_date: z.string().min(4).optional().describe('Expected close date, ISO `YYYY-MM-DD`.'),
  owner_name: z.string().max(120).optional().describe('Opportunity owner (a person name).'),
};

const updateSchema = {
  id: z.string().min(1).describe(ID_DESCRIPTION),
  name: z.string().min(1).max(200).optional().describe('New opportunity name.'),
  account_id: z.string().min(1).nullable().optional().describe('Reassign the account; null clears it.'),
  stage: stageSchema.optional().describe('New pipeline stage.'),
  amount: z.union([z.number(), z.string()]).nullable().optional().describe('New deal value in USD.'),
  close_date: z.string().min(4).nullable().optional().describe('New close date, ISO `YYYY-MM-DD`; null clears it.'),
  owner_name: z.string().max(120).nullable().optional().describe('New owner; null clears it.'),
  probability: z.number().int().min(0).max(100).nullable().optional().describe('Win probability 0-100; null clears it.'),
};

export function registerOpportunityTools(server: McpServer, ctx: ToolContext): string[] {
  const { crm } = ctx;

  server.registerTool(
    'list_opportunities',
    {
      title: 'List opportunities',
      description:
        'Returns a paginated page of opportunities as `{ data, meta }` (name, stage, amount, close date, account, ' +
        'owner). Filter by `stage`, a free-text `search` over the opportunity name, and/or `account_id`. Use it ' +
        'for pipeline questions like "what is in Negotiation". Amounts are USD; `stage` is one of Prospecting, ' +
        'Qualification, Proposal, Negotiation, Closed Won, Closed Lost.',
      inputSchema: {
        stage: stageSchema.optional().describe('Exact stage filter.'),
        search: z.string().min(1).max(200).optional().describe('Case-insensitive text matched against the opportunity name.'),
        account_id: z.string().min(1).optional().describe('Only opportunities for this account (local uuid or Salesforce id).'),
        limit: z.number().int().min(1).max(200).optional().describe('Page size, 1-200 (default 50).'),
        offset: z.number().int().min(0).optional().describe('Rows to skip (default 0).'),
      },
      outputSchema: listOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ stage, search, account_id, limit, offset }) =>
      runTool(async () => {
        const pageLimit = limit ?? 50;
        const pageOffset = offset ?? 0;
        const payload = await crm.get('/api/crm/opportunities', {
          query: { stage, search, account_id, limit: pageLimit, offset: pageOffset },
        });
        const { rows, meta } = normalizeList<Opportunity>(payload, {
          limit: pageLimit,
          offset: pageOffset,
        });
        const table = renderTable(
          ['name', 'stage', '$amount', 'close date'],
          rows.map((opportunity) => [
            opportunity.name,
            opportunity.stage,
            formatMoney(opportunity.amount),
            opportunity.close_date ?? 'n/a',
          ]),
          { total: meta.total },
        );
        return {
          text: `${listHeading('opportunities', meta, { stage, search, account_id })}\n${table}`,
          structured: { data: rows, meta: { ...meta } },
        };
      }),
  );

  server.registerTool(
    'get_opportunity',
    {
      title: 'Get opportunity',
      description:
        'Returns one opportunity as `{ data }` with stage, amount, close date, account, owner and probability. ' +
        'Use it to inspect a single deal after list_opportunities. The `id` accepts either the local uuid or the ' +
        'Salesforce id.',
      inputSchema: { id: z.string().min(1).describe(ID_DESCRIPTION) },
      outputSchema: entityOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ id }) =>
      runTool(async () => {
        const payload = await crm.get(`/api/crm/opportunities/${encodeURIComponent(id)}`);
        const opportunity = unwrapEntity<Opportunity>(payload);
        return { text: opportunityDetail(opportunity), structured: { data: opportunity } };
      }),
  );

  server.registerTool(
    'create_opportunity',
    {
      title: 'Create opportunity',
      description:
        'Creates a local opportunity (source `local`) and returns it in `{ data }`. Use it to register a new deal ' +
        'in the pipeline; `account_id` is optional but you should resolve it first with search_accounts. ' +
        '`amount` is USD and `close_date` is ISO `YYYY-MM-DD`. Stage defaults to Prospecting.',
      inputSchema: createSchema,
      outputSchema: entityOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) =>
      runTool(async () => {
        const payload = await crm.post('/api/crm/opportunities', input);
        const opportunity = unwrapEntity<Opportunity>(payload);
        return {
          text:
            `Created opportunity "${opportunity.name}" (id: ${opportunity.id})\n` +
            fieldLines([
              ['stage', opportunity.stage],
              ['amount', formatMoney(opportunity.amount)],
              ['close date', opportunity.close_date],
              ['account', opportunity.account_name ?? opportunity.account_id],
            ]),
          structured: { data: opportunity },
        };
      }),
  );

  server.registerTool(
    'update_opportunity',
    {
      title: 'Update opportunity',
      description:
        'Partially updates an opportunity (typically the `stage`, `amount` or `close_date`) and returns the ' +
        'updated record in `{ data }`. Only the fields you send change. The `id` accepts either the local uuid or ' +
        'the Salesforce id. Idempotent.',
      inputSchema: updateSchema,
      outputSchema: entityOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, ...patch }) =>
      runTool(async () => {
        const payload = await crm.patch(`/api/crm/opportunities/${encodeURIComponent(id)}`, patch);
        const opportunity = unwrapEntity<Opportunity>(payload);
        return {
          text: `Updated opportunity "${opportunity.name}"\n${opportunityDetail(opportunity)}`,
          structured: { data: opportunity },
        };
      }),
  );

  return ['list_opportunities', 'get_opportunity', 'create_opportunity', 'update_opportunity'];
}
