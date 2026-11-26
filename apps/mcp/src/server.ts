/**
 * MCP server factory.
 *
 * Kept free of Express so tests can build an instance without HTTP. The HTTP
 * entry point (`src/index.ts`) creates a *fresh* instance per request, which is
 * the documented stateless pattern for `StreamableHTTPServerTransport`.
 */

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './tools';
import type { ToolContext } from './tools/context';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };

export const SERVER_NAME = 'poc-crm-mcp';
export const SERVER_VERSION = pkg.version ?? '0.0.0';

const INSTRUCTIONS = [
  'CRM read/write tools for the POC Salesforce-migration CRM.',
  'Start with get_sales_summary for an overview, list_* to browse, get_* to inspect one record.',
  'Opportunities use `stage`; leads use `status` and `source`.',
  'Ids accept either the local uuid or the Salesforce id.',
  'Money is USD. Prefer these tools over guessing values.',
].join(' ');

export interface BuiltMcpServer {
  server: McpServer;
  /** Names in registration order — used by `/health` and the test suite. */
  toolNames: string[];
}

/** Builds an `McpServer` with all 17 CRM tools registered. */
export function buildMcpServer(ctx: ToolContext): BuiltMcpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  const toolNames = registerAllTools(server, ctx);
  return { server, toolNames };
}
