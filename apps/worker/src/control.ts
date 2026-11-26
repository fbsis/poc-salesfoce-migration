/**
 * Worker control HTTP endpoint (`PORT_CONTROL`, default 3002).
 *
 * The worker is normally driven by argv / `WORKER_MODE`, which makes the bulk
 * extract impossible to trigger from another container (an E2E test cannot
 * shell out to `docker`). This tiny server exposes the two jobs the worker
 * already knows how to run:
 *
 *   GET  /health         -> { status, mode, busy, lastBulkRun }
 *   POST /run/bulk       -> run one Bulk API 2.0 extraction, answer with the summary
 *   POST /run/reconcile  -> run one reconciliation pass, answer with the report
 *
 * Every route requires `Authorization: Bearer ${CRM_API_TOKEN}` — this is an
 * operational control plane, not an internal CRM route, but the POC has one
 * token and reusing it keeps the demo simple.
 *
 * `POST /run/bulk` is **synchronous**: it answers `200` with the full summary
 * (`{ jobId: <syncRunId>, status, totals, objects, … }`) once the extraction has
 * finished, or `500` with the same shape when the run reported a failure. That
 * is deliberate — a caller that gets a 200 knows the data is in Postgres, so no
 * second wait/poll protocol is needed. `GET /health` exposes the same summary
 * under `lastBulkRun` for polling/observability. A second request while a run
 * is in flight answers `409` (single-flight lock: Bulk API jobs are expensive
 * and two concurrent extractions would race on the same rows).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import express, { type Express, type Request, type Response } from 'express';
import { listSyncRuns } from '@poc/core';
import { reconcile, runBulkExtract, type BulkExtractSummary } from '@poc/salesforce';

export type ControlMode = string;

/** Compact bulk-run shape exposed by `GET /health`. */
export interface BulkRunHealth {
  syncRunId: string;
  status: 'running' | 'success' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  totals: BulkExtractSummary['totals'] | null;
}

export interface ControlServerOptions {
  /** Worker mode, echoed by `/health` (e.g. `all`). */
  mode: ControlMode;
  /** Defaults to `PORT_CONTROL` or 3002. */
  port?: number;
  /** Defaults to `CRM_API_TOKEN`. An empty token fails closed (401). */
  token?: string;
  /** Structured log sink. Defaults to console. */
  log?: (line: string) => void;
}

export interface ControlServer {
  port: number;
  close: () => Promise<void>;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time bearer check on equal-length digests. */
export function isAuthorized(header: unknown, expected: string): boolean {
  if (typeof header !== 'string' || expected === '') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return timingSafeEqual(digest(match[1] ?? ''), digest(expected));
}

function json(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createControlApp(options: ControlServerOptions): {
  app: Express;
  state: { lastBulkRun: BulkRunHealth | null };
} {
  const token = (options.token ?? process.env.CRM_API_TOKEN ?? '').trim();
  const log = options.log ?? ((line: string) => console.log(`[control] ${line}`));
  const state: { lastBulkRun: BulkRunHealth | null } = { lastBulkRun: null };
  let busy: 'bulk' | 'reconcile' | null = null;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use((req: Request, res: Response, next: () => void) => {
    if (!isAuthorized(req.headers.authorization, token)) {
      json(res, 401, {
        error: { code: 'unauthorized', message: 'Missing or invalid bearer token' },
      });
      return;
    }
    next();
  });

  app.get('/health', async (_req: Request, res: Response): Promise<void> => {
    // Fall back to the persisted run so `/health` is useful after a restart.
    let lastBulkRun = state.lastBulkRun;
    if (!lastBulkRun) {
      try {
        const run = (await listSyncRuns(50)).find((entry) => entry.kind === 'bulk_extract');
        if (run) {
          lastBulkRun = {
            syncRunId: run.id,
            status: run.status,
            startedAt: run.started_at,
            finishedAt: run.finished_at,
            durationMs: null,
            totals: null,
          };
        }
      } catch (error) {
        log(`health: could not read sync runs (${message(error)})`);
      }
    }
    json(res, 200, { status: 'ok', mode: options.mode, busy, lastBulkRun });
  });

  app.post('/run/bulk', async (_req: Request, res: Response): Promise<void> => {
    if (busy) {
      json(res, 409, {
        error: { code: 'conflict', message: `a ${busy} run is already in progress` },
      });
      return;
    }
    busy = 'bulk';
    const startedAt = new Date().toISOString();
    log('bulk run requested');
    try {
      const summary = await runBulkExtract({ log: (line) => console.log(line) });
      const failed = summary.totals.errors > 0;
      state.lastBulkRun = {
        syncRunId: summary.syncRunId,
        status: failed ? 'failed' : 'success',
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        durationMs: summary.durationMs,
        totals: summary.totals,
      };
      log(
        `bulk run ${summary.syncRunId} ${failed ? 'failed' : 'ok'} ` +
          `read=${summary.totals.read} applied=${summary.totals.applied} ` +
          `skipped_stale=${summary.totals.skipped_stale} errors=${summary.totals.errors} ` +
          `duration=${summary.durationMs}ms`,
      );
      json(res, failed ? 500 : 200, {
        jobId: summary.syncRunId,
        kind: 'bulk_extract',
        status: failed ? 'failed' : 'success',
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        durationMs: summary.durationMs,
        totals: summary.totals,
        objects: summary.objects,
      });
    } catch (error) {
      state.lastBulkRun = {
        syncRunId: state.lastBulkRun?.syncRunId ?? '',
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(startedAt),
        totals: null,
      };
      log(`bulk run crashed: ${message(error)}`);
      json(res, 500, {
        error: { code: 'internal', message: `bulk extract failed: ${message(error)}` },
      });
    } finally {
      busy = null;
    }
  });

  app.post('/run/reconcile', async (_req: Request, res: Response): Promise<void> => {
    if (busy) {
      json(res, 409, {
        error: { code: 'conflict', message: `a ${busy} run is already in progress` },
      });
      return;
    }
    busy = 'reconcile';
    log('reconcile run requested');
    try {
      const report = await reconcile({ log: (line) => console.log(line) });
      json(res, report.ok ? 200 : 500, {
        jobId: report.syncRunId,
        kind: 'reconcile',
        status: report.ok ? 'success' : 'failed',
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        durationMs: report.durationMs,
        rows: report.rows,
      });
    } catch (error) {
      log(`reconcile run crashed: ${message(error)}`);
      json(res, 500, {
        error: { code: 'internal', message: `reconcile failed: ${message(error)}` },
      });
    } finally {
      busy = null;
    }
  });

  app.use((_req: Request, res: Response) => {
    json(res, 404, {
      error: { code: 'not_found', message: 'Use GET /health, POST /run/bulk or POST /run/reconcile.' },
    });
  });

  return { app, state };
}

/** Start the control server. Never throws for a port conflict; logs and returns null. */
export function startControlServer(options: ControlServerOptions): Promise<ControlServer | null> {
  const port = options.port ?? Number(process.env.PORT_CONTROL ?? 3002);
  const log = options.log ?? ((line: string) => console.log(`[control] ${line}`));
  const { app } = createControlApp({ ...options, log });

  return new Promise((resolve) => {
    const server = app.listen(port, '0.0.0.0', () => {
      log(`listening port=${port} mode=${options.mode}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
    server.on('error', (error: Error) => {
      log(`could not listen on port ${port}: ${error.message}`);
      resolve(null);
    });
  });
}
