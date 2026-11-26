/**
 * Tool registry — one place that knows the full catalogue (CONTRACTS.md §8).
 * Returns the registered names so `/health` and the tests can assert the count
 * without reaching into SDK internals.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAccountTools } from './accounts';
import { registerLeadTools } from './leads';
import { registerOpportunityTools } from './opportunities';
import { registerReportingTools } from './reporting';
import type { ToolContext } from './context';

export function registerAllTools(server: McpServer, ctx: ToolContext): string[] {
  return [
    ...registerAccountTools(server, ctx),
    ...registerOpportunityTools(server, ctx),
    ...registerLeadTools(server, ctx),
    ...registerReportingTools(server, ctx),
  ];
}

export type { ToolContext } from './context';
