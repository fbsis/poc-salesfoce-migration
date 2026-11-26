/**
 * HTTP entry point: Express + MCP Streamable HTTP transport, stateless.
 *
 * Routes:
 *   GET    /health  -> { status, tools, upstream }
 *   POST   /mcp     -> JSON-RPC (initialize, tools/list, tools/call, ...)
 *   GET    /mcp     -> 405 in stateless mode (no server-initiated stream)
 *   DELETE /mcp     -> no session to terminate (transport answers)
 *
 * Statelessness: every request gets its own `McpServer` + transport with
 * `sessionIdGenerator: undefined`, so no state is kept between requests and
 * horizontally scaling the process is safe. Clients must therefore NOT expect
 * a `Mcp-Session-Id` header, and must re-send the full JSON-RPC envelope.
 */

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createAuthMiddleware } from './auth';
import { createCrmClientFromEnv, type CrmClient } from './crm-client';
import { logger } from './logger';
import { buildMcpServer, SERVER_NAME, SERVER_VERSION } from './server';

const MAX_BODY = '1mb';

export interface AppOptions {
  crm: CrmClient;
  /** Token required on `/mcp`. Empty string disables every request (fail closed). */
  authToken: string;
}

/** Arguments are logged by *key* only — a lead payload must never reach the log. */
function describeRpc(body: unknown): Record<string, unknown> {
  const envelope = body as
    | { method?: unknown; params?: { name?: unknown; arguments?: unknown } }
    | undefined;
  const method = typeof envelope?.method === 'string' ? envelope.method : undefined;
  const tool =
    method === 'tools/call' && typeof envelope?.params?.name === 'string'
      ? envelope.params.name
      : undefined;
  const args = envelope?.params?.arguments;
  const argKeys = args && typeof args === 'object' ? Object.keys(args as Record<string, unknown>) : undefined;
  return { rpc_method: method, tool, arg_keys: argKeys };
}

function createMcpRequestHandler(crm: CrmClient): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    const rpc = describeRpc(req.body);
    // Fresh server + transport per request: the safest stateless pattern.
    const { server } = buildMcpServer({ crm });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    };
    res.on('close', cleanup);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('mcp.request.error', {
        ...rpc,
        method: req.method,
        message: error instanceof Error ? error.message : 'unknown error',
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: 'Internal server error' },
        });
      }
    } finally {
      const status = res.statusCode;
      logger.info('mcp.request', {
        method: req.method,
        ...rpc,
        status,
        duration_ms: Date.now() - startedAt,
        outcome: status < 400 ? 'ok' : 'error',
      });
    }
  };
}

export function createApp(options: AppOptions): Express {
  const { crm, authToken } = options;
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: MAX_BODY }));

  // Tool count without keeping a server instance around.
  const toolCount = buildMcpServer({ crm }).toolNames.length;

  app.get('/health', async (_req: Request, res: Response): Promise<void> => {
    const upstream = await crm.ping();
    res.status(200).json({ status: 'ok', tools: toolCount, upstream });
  });

  // Auth gates `/mcp` only: `/health` stays open for container healthchecks.
  app.use('/mcp', createAuthMiddleware(authToken));

  const handler = createMcpRequestHandler(crm);
  app.post('/mcp', handler);
  app.get('/mcp', handler);
  app.delete('/mcp', handler);

  app.use((_req: Request, res: Response): void => {
    res.status(404).json({ error: { code: 'not_found', message: 'Use POST /mcp or GET /health.' } });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    const isBodyError = error instanceof SyntaxError || (error as { type?: string })?.type === 'entity.too.large';
    const status = isBodyError ? (error as { status?: number }).status ?? 400 : 500;
    logger.warn('http.error', { status, message: error instanceof Error ? error.message : 'unknown' });
    if (res.headersSent) return;
    res.status(status).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: status === 500 ? -32603 : -32700, message: 'Invalid request body.' },
    });
  });

  return app;
}

export interface StartedServer {
  close: () => Promise<void>;
}

export function startServer(env: NodeJS.ProcessEnv = process.env): StartedServer {
  const port = Number(env.MCP_PORT ?? 3001);
  const crm = createCrmClientFromEnv(env);
  const app = createApp({ crm, authToken: env.MCP_AUTH_TOKEN ?? '' });

  const httpServer = app.listen(port, '0.0.0.0', () => {
    logger.info('mcp.listening', {
      port,
      server: SERVER_NAME,
      version: SERVER_VERSION,
      transport: 'streamable-http',
      stateless: true,
      crm_api: env.CRM_API_BASE_URL ?? 'http://localhost:3000',
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('mcp.shutdown', { signal });
    const timer = setTimeout(() => {
      logger.warn('mcp.shutdown.timeout');
      process.exit(1);
    }, 5_000);
    timer.unref();
    httpServer.close(() => {
      clearTimeout(timer);
      logger.info('mcp.shutdown.complete');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return {
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  startServer();
}
