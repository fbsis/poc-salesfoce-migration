/**
 * Reporting tools (CONTRACTS.md §8): get_sales_summary,
 * get_opportunities_by_stage, get_lead_summary, get_sync_status.
 *
 * Read-only rollups over the internal CRM API. Money in the text summary is
 * formatted with Intl; the structured payload keeps the raw numbers.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Lead, LeadSummary, SalesSummary, StageSummary, SyncStatus } from '@poc/core';
import type { ToolContext } from './context';
import { formatDate, formatMoney, renderTable, runTool, unwrapEntity } from './shared';

const recordOutputSchema = { data: z.record(z.unknown()) };
const listOutputSchema = { data: z.array(z.unknown()) };

function count(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function registerReportingTools(server: McpServer, ctx: ToolContext): string[] {
  const { crm } = ctx;

  server.registerTool(
    'get_sales_summary',
    {
      title: 'Get sales summary',
      description:
        'Returns the CRM headline counters in `{ data }`: accounts, contacts, opportunities, leads, pipeline value ' +
        '(open deals), won value, open opportunity count, new leads, and how many records came from Salesforce ' +
        'vs. locally. Use it for a status overview before drilling into a list.',
      inputSchema: {},
      outputSchema: recordOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async () =>
      runTool(async () => {
        const payload = await crm.get('/api/crm/reports/sales-summary');
        const summary = unwrapEntity<SalesSummary>(payload);
        const text = [
          `Sales summary — ${count(summary.salesforceRecords)} Salesforce record(s), ${count(summary.localRecords)} local`,
          `accounts      ${count(summary.accounts)}`,
          `contacts      ${count(summary.contacts)}`,
          `opportunities ${count(summary.opportunities)} (open: ${count(summary.openOpportunities)})`,
          `pipeline      ${formatMoney(summary.pipelineValue)}`,
          `won           ${formatMoney(summary.wonValue)}`,
          `leads         ${count(summary.leads)} (new: ${count(summary.newLeads)})`,
        ].join('\n');
        return { text, structured: { data: summary } };
      }),
  );

  server.registerTool(
    'get_opportunities_by_stage',
    {
      title: 'Get opportunities by stage',
      description:
        'Returns the pipeline broken down by stage in `{ data }` (array of `{ stage, count, totalAmount }`, in ' +
        'canonical pipeline order). Use it for funnel/forecast questions such as "how much is in Negotiation" — ' +
        'cheaper than paging through list_opportunities.',
      inputSchema: {},
      outputSchema: listOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async () =>
      runTool(async () => {
        const payload = await crm.get('/api/crm/reports/opportunities-by-stage');
        const unwrapped = unwrapEntity<unknown>(payload);
        const rows = Array.isArray(unwrapped) ? (unwrapped as StageSummary[]) : [];
        const total = rows.reduce((sum, row) => sum + count(row.totalAmount), 0);
        const table = renderTable(
          ['stage', 'count', '$total'],
          rows.map((row) => [row.stage, count(row.count), formatMoney(row.totalAmount)]),
          { total: rows.length },
        );
        return {
          text: `Pipeline by stage — ${formatMoney(total)} total\n${table}`,
          structured: { data: rows },
        };
      }),
  );

  server.registerTool(
    'get_lead_summary',
    {
      title: 'Get lead summary',
      description:
        'Returns lead analytics in `{ data }`: total, counts by status, counts by source, new-today count and the ' +
        'latest leads. Optional `since` (ISO date) narrows the window. Use it for "how are website leads doing" ' +
        'style questions; use list_leads when you need to act on individual leads.',
      inputSchema: {
        since: z.string().min(4).optional().describe('Only count leads created on/after this ISO date (`YYYY-MM-DD`).'),
      },
      outputSchema: recordOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ since }) =>
      runTool(async () => {
        const payload = await crm.get('/api/crm/reports/lead-summary', { query: { since } });
        const summary = unwrapEntity<LeadSummary>(payload);
        const byStatus = (summary.byStatus ?? [])
          .map((entry) => `${entry.status} ${count(entry.count)}`)
          .join(', ');
        const bySource = (summary.bySource ?? [])
          .map((entry) => `${entry.source} ${count(entry.count)}`)
          .join(', ');
        const latest = (summary.latest ?? []).slice(0, 5) as Lead[];
        const lines = [
          `Leads${since ? ` since ${since}` : ''} — ${count(summary.total)} total, ${count(summary.newToday)} new today`,
          `by status: ${byStatus || 'n/a'}`,
          `by source: ${bySource || 'n/a'}`,
        ];
        if (latest.length > 0) {
          lines.push(
            'latest:',
            renderTable(
              ['name', 'status', 'source', 'created'],
              latest.map((lead) => [
                lead.full_name,
                lead.status,
                lead.source,
                formatDate(lead.created_at),
              ]),
            ),
          );
        }
        return { text: lines.join('\n'), structured: { data: summary } };
      }),
  );

  server.registerTool(
    'get_sync_status',
    {
      title: 'Get sync status',
      description:
        'Returns Salesforce sync health in `{ data }`: whether a run is in progress, the last bulk extract, the ' +
        'last CDC event timestamp, replication lag in seconds, event counters (total / failed / stale-skipped) ' +
        'and the CDC checkpoints with their replay ids. Use it to answer "is the migration in sync" and to ' +
        'explain stale data.',
      inputSchema: {},
      outputSchema: recordOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async () =>
      runTool(async () => {
        const payload = await crm.get('/api/crm/sync/status');
        const status = unwrapEntity<SyncStatus>(payload);
        const lastRun = status.lastBulkRun;
        const counts = status.counts ?? { cdcEvents: 0, failedEvents: 0, staleSkipped: 0 };
        const lines = [
          `Sync ${status.running ? 'RUNNING' : 'idle'} — lag: ${
            status.lagSeconds === null || status.lagSeconds === undefined ? 'n/a' : `${status.lagSeconds}s`
          }`,
          `last bulk run: ${
            lastRun
              ? `${lastRun.status} at ${formatDate(lastRun.started_at)} (read ${count(lastRun.records_read)}, wrote ${count(
                  lastRun.records_written,
                )})`
              : 'none'
          }`,
          `last cdc event: ${status.lastCdcEventAt ?? 'none'}`,
          `events: ${count(counts.cdcEvents)} total, ${count(counts.failedEvents)} failed, ${count(
            counts.staleSkipped,
          )} stale skipped`,
        ];
        const checkpoints = status.checkpoints ?? [];
        if (checkpoints.length > 0) {
          lines.push(
            'checkpoints:',
            renderTable(
              ['channel', 'replay id', 'last event', 'status'],
              checkpoints.slice(0, 4).map((checkpoint) => [
                checkpoint.channel,
                checkpoint.replay_id ?? 'n/a',
                formatDate(checkpoint.last_event_at),
                checkpoint.status,
              ]),
              { total: checkpoints.length },
            ),
          );
        }
        return { text: lines.join('\n'), structured: { data: status } };
      }),
  );

  return ['get_sales_summary', 'get_opportunities_by_stage', 'get_lead_summary', 'get_sync_status'];
}
