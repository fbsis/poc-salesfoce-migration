/**
 * Worker entrypoint: Bulk API 2.0 extraction + CDC consumer + reconciliation.
 *
 *   tsx src/index.ts bulk        one extraction pass, summary, exit 0/1
 *   tsx src/index.ts cdc         Pub/Sub consumer in the foreground
 *   tsx src/index.ts reconcile   gap report per object
 *   tsx src/index.ts all         bulk (if stale) then cdc
 *   tsx src/index.ts once        bulk + reconcile, then exit
 *
 * With no argv the mode comes from `WORKER_MODE` (default `all`), so
 * `docker compose up worker` does the right thing.
 */
import { closePool, listSyncRuns } from '@poc/core';
import {
  CdcConsumer,
  reconcile,
  runBulkExtract,
  startConsumer,
  stopConsumer,
  type BulkExtractSummary,
  type CdcEventLog,
  type ReconcileReport,
} from '@poc/salesforce';

import { startControlServer, type ControlServer } from './control';

type Mode = 'bulk' | 'cdc' | 'reconcile' | 'all' | 'once';

const MODES: readonly Mode[] = ['bulk', 'cdc', 'reconcile', 'all', 'once'];

/** Skip `bulk` on `all` when it succeeded this recently (restart-loop guard). */
const BULK_FRESH_WINDOW_MS = Number(process.env.WORKER_BULK_SKIP_WINDOW_MS ?? 10 * 60 * 1000);

function log(message: string): void {
  console.log(`[worker] ${message}`);
}

/** Set once the control server is up; closed on shutdown. */
let controlServer: ControlServer | null = null;

function logError(message: string): void {
  console.error(`[worker] ${message}`);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function flag(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

function resolveMode(argv: string[]): Mode {
  const candidate = (argv[0] ?? process.env.WORKER_MODE ?? 'all').trim().toLowerCase();
  if ((MODES as readonly string[]).includes(candidate)) return candidate as Mode;
  throw new Error(`unknown mode "${candidate}" (expected ${MODES.join('|')})`);
}

function printUsage(): void {
  console.log('usage: tsx src/index.ts <bulk|cdc|reconcile|all|once>');
}

function printBulkSummary(summary: BulkExtractSummary, label: string): void {
  log(`${label} sync_run=${summary.syncRunId} duration=${summary.durationMs}ms`);
  for (const entry of summary.objects) {
    log(
      `  ${entry.object.padEnd(11)} read=${String(entry.read).padStart(3)} ` +
        `applied=${String(entry.applied).padStart(3)} ` +
        `skipped_stale=${String(entry.skipped_stale).padStart(3)} ` +
        `ignored=${String(entry.ignored).padStart(3)} errors=${entry.errors.length}`,
    );
    for (const error of entry.errors.slice(0, 5)) {
      logError(`  ${entry.object} error ${error.id}: ${error.message}`);
    }
  }
  log(
    `  TOTAL       read=${summary.totals.read} applied=${summary.totals.applied} ` +
      `skipped_stale=${summary.totals.skipped_stale} ignored=${summary.totals.ignored} ` +
      `errors=${summary.totals.errors}`,
  );
}

function printReconcileReport(report: ReconcileReport): void {
  log(`reconcile sync_run=${report.syncRunId} duration=${report.durationMs}ms ok=${report.ok}`);
  for (const row of report.rows) {
    log(
      `  ${row.object.padEnd(11)} salesforce=${String(row.salesforceCount).padStart(3)} ` +
        `local=${String(row.localCount).padStart(3)} missing=${String(row.missingLocally).padStart(3)} ` +
        `newest_sf=${row.newestSalesforce ?? 'n/a'} newest_local=${row.newestLocal ?? 'n/a'} ` +
        `${row.consistent ? 'consistent' : 'DRIFT'}`,
    );
  }
}

/** Most recent bulk_extract run, if any. */
async function latestBulkRun(): Promise<{ status: string; finishedAt: string | null } | null> {
  const runs = await listSyncRuns(50);
  const run = runs.find((entry) => entry.kind === 'bulk_extract');
  if (!run) return null;
  return { status: run.status, finishedAt: run.finished_at };
}

async function bulkIsFresh(): Promise<boolean> {
  if (flag(process.env.WORKER_FORCE_BULK)) return false;
  try {
    const latest = await latestBulkRun();
    if (!latest || latest.status !== 'success' || !latest.finishedAt) return false;
    const ageMs = Date.now() - Date.parse(latest.finishedAt);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > BULK_FRESH_WINDOW_MS) return false;
    log(
      `bulk already succeeded ${Math.round(ageMs / 1000)}s ago ` +
        `(window ${Math.round(BULK_FRESH_WINDOW_MS / 1000)}s) — skipping, set WORKER_FORCE_BULK=1 to override`,
    );
    return true;
  } catch (error) {
    logError(`could not inspect sync runs (${describe(error)}) — running bulk anyway`);
    return false;
  }
}

async function runBulk(label: string): Promise<boolean> {
  log(`${label} starting bulk extract (Account → Contact → Opportunity → Lead)`);
  const summary = await runBulkExtract({ log: (line) => console.log(line) });
  printBulkSummary(summary, label);
  if (summary.totals.errors > 0) {
    logError(`${label} finished with ${summary.totals.errors} per-record errors`);
    return false;
  }
  log(`${label} ok`);
  return true;
}

async function runReconcile(): Promise<boolean> {
  const report = await reconcile({ log: (line) => console.log(line) });
  printReconcileReport(report);
  return report.ok;
}

/** Foreground consumer; resolves only when a signal stops it. */
async function runCdc(signal: Promise<string>): Promise<void> {
  // A container restart that kills node before its SIGTERM handler runs leaves a
  // `cdc` sync run `running` forever, which would make the dashboard claim the
  // worker is syncing when it is not. This is the one place where "every
  // `running` cdc run belongs to a dead process" holds by construction.
  try {
    await CdcConsumer.reapOrphanSyncRuns((line) => console.log(line));
  } catch (error) {
    logError(`could not reap orphaned cdc sync runs: ${describe(error)}`);
  }

  const consumer = await startConsumer({
    onEvent: (info: CdcEventLog) => {
      // The compact `[cdc]` line is printed by the consumer itself; keep a
      // structured record available for log shipping when asked.
      if (process.env.WORKER_CDC_JSON === '1') {
        console.log(`[worker] cdc_event ${JSON.stringify(info)}`);
      }
    },
  });
  log(`cdc consuming ${consumer.topics.length} topics — ctrl-c / SIGTERM to stop`);

  const received = await signal;
  log(`${received} received, stopping consumer`);
  await stopConsumer();
  log(
    `cdc stopped: events=${consumer.stats.events} applied=${consumer.stats.applied} ` +
      `skipped_stale=${consumer.stats.skipped_stale} ignored=${consumer.stats.ignored} ` +
      `failed=${consumer.stats.failed} duplicates=${consumer.stats.duplicates} ` +
      `blocked=${consumer.stats.blocked} held=${consumer.stats.held} ` +
      `reconnects=${consumer.stats.reconnects}`,
  );
}

async function run(mode: Mode, signal: Promise<string>): Promise<number> {
  log(
    `mode=${mode} mock=${process.env.SF_USE_MOCK ?? 'true'} ` +
      `api=${process.env.SF_API_VERSION ?? 'v62.0'} ` +
      `pubsub=${process.env.PUBSUB_ENDPOINT ?? 'default'}`,
  );

  switch (mode) {
    case 'bulk':
      return (await runBulk('bulk')) ? 0 : 1;
    case 'reconcile':
      return (await runReconcile()) ? 0 : 1;
    case 'once': {
      const bulkOk = await runBulk('once');
      const reconcileOk = await runReconcile();
      return bulkOk && reconcileOk ? 0 : 1;
    }
    case 'cdc':
      await runCdc(signal);
      return 0;
    case 'all':
      if (await bulkIsFresh()) {
        log('skipping bulk (fresh) — moving straight to the CDC consumer');
      } else {
        const ok = await runBulk('all');
        if (!ok) logError('bulk extract failed — CDC consumer still starts');
      }
      await runCdc(signal);
      return 0;
    default:
      printUsage();
      return 2;
  }
}

async function finish(code: number): Promise<never> {
  try {
    await controlServer?.close();
  } catch (error) {
    logError(`control shutdown failed: ${describe(error)}`);
  }
  try {
    await stopConsumer();
  } catch (error) {
    logError(`consumer shutdown failed: ${describe(error)}`);
  }
  try {
    await closePool();
  } catch (error) {
    logError(`pool shutdown failed: ${describe(error)}`);
  }
  process.exit(code);
}

async function entry(): Promise<void> {
  const argv = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  let mode: Mode;
  try {
    mode = resolveMode(argv);
  } catch (error) {
    logError(describe(error));
    printUsage();
    process.exit(2);
  }

  // Operational control plane (PORT_CONTROL, default 3002). Started in every
  // mode so an E2E test can trigger a bulk extract without shelling out.
  controlServer = await startControlServer({ mode });

  const signal = new Promise<string>((resolve) => {
    process.once('SIGTERM', () => resolve('SIGTERM'));
    process.once('SIGINT', () => resolve('SIGINT'));
  });

  const running = run(mode, signal).then((code) => ({ kind: 'done' as const, code }));

  if (mode === 'cdc' || mode === 'all') {
    // The signal is consumed inside runCdc so the summary is printed first.
    const outcome = await running;
    await finish(outcome.code);
  }

  const outcome = await Promise.race([
    running,
    signal.then((name) => ({ kind: 'signal' as const, name })),
  ]);
  if (outcome.kind === 'signal') {
    log(`${outcome.name} received`);
    return finish(0);
  }
  return finish(outcome.code);
}

process.on('unhandledRejection', (reason) => {
  logError(`unhandled rejection: ${describe(reason)}`);
});

entry().catch((error: unknown) => {
  logError(`fatal: ${describe(error)}`);
  void finish(1);
});
