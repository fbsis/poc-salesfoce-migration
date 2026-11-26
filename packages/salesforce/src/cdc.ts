/**
 * Salesforce Pub/Sub API consumer (gRPC + Avro CDC) — docs/CONTRACTS.md §7.
 *
 * Proto: `packages/salesforce/proto/pubsub_api.proto`, package `eventbus.v1`,
 * service `PubSub` (vendored verbatim from forcedotcom/pub-sub-api).
 *
 * Per event, strictly in this order (at-least-once, deduped, replayable):
 *   1. decode the Avro payload with the schema from `GetSchema`
 *   2. `recordCdcEvent(<channel>:<replayId>)`      → duplicate? skip + advance checkpoint
 *   3. `applySalesforceRecord` / `deleteSalesforceRecord` (bounded retry, see below)
 *   4. `markCdcEventProcessed(outcome)` with `latency_ms = now - commitTimestamp`
 *   5. `saveCheckpoint(channel, replayId)` **after** the row is written
 *
 * ## Failure semantics (audit P0-2)
 *
 * An apply that throws is retried **in-process** up to `APPLY_ATTEMPTS` times
 * (250 ms / 1 s / 3 s backoff). If every attempt fails the event is dead-lettered
 * (`cdc_events.status='failed'`, payload + error kept) and the checkpoint is
 * **not** advanced: the topic's stream is cancelled, the checkpoint row is left
 * at `status='error'`, and an unmissable `[cdc][ALERT]` line is printed.
 * `runTopic` then reconnects after its normal backoff and re-subscribes from that
 * same checkpoint, which re-delivers the poison event.
 *
 * That is **deliberate head-of-line blocking**: one unappliable event stops its
 * topic until an operator fixes the data (or the code) and the event applies, or
 * `redriveFailedEvents()` re-applies it out of band. Bounded and safe beats
 * silent loss: nothing is ever skipped, at the cost of that topic lagging while
 * the event is broken. Events *behind* the blocked replay id are dropped
 * unrecorded and re-fetched by the replay, so the checkpoint can never jump over
 * the poison event. Duplicates are still skipped *and* advanced — a duplicate
 * means "already applied" — except when the stored row is itself `failed`,
 * in which case it is treated as a retry (that is the poison event coming back).
 *
 * Reconnect: exponential backoff with jitter (1s → 30s cap) resuming from the
 * persisted checkpoint. `error` never escapes the process; `end` reconnects.
 *
 * ## Sync runs (audit P1-3)
 *
 * One `cdc` row in `sync_runs` per consumer lifetime: opened on `start()`, closed
 * on `stop()` (or after every topic has been disconnected for ~30 s), and a new
 * one opened on the next live subscription, so `/api/crm/sync/status` never
 * reports "Idle" while the consumer is up.
 */
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import avro from 'avsc';
import {
  applySalesforceRecord,
  deleteSalesforceRecord,
  getCheckpoint,
  listCdcEvents,
  markCdcEventProcessed,
  query,
  queryOne,
  recordCdcEvent,
  saveCheckpoint,
  startSyncRun,
  finishSyncRun,
  type ChangeType,
  type SalesforceRecord,
} from '@poc/core';

import { getAccessToken } from './auth';
import { backoffConfig, defaultTopics, pubsubEndpoint, sfUseMock } from './config';

const PROTO_PATH = fileURLToPath(new URL('../proto/pubsub_api.proto', import.meta.url));

/** ReplayPreset enum values from the proto (LATEST=0, EARLIEST=1, CUSTOM=2). */
export const REPLAY_PRESET = { LATEST: 0, EARLIEST: 1, CUSTOM: 2 } as const;
export type ReplayPreset = (typeof REPLAY_PRESET)[keyof typeof REPLAY_PRESET];

const PROTO_OPTIONS: protoLoader.Options = {
  keepCase: false,
  longs: Number,
  enums: Number,
  defaults: true,
  oneofs: true,
};

const DEFAULT_BATCH_SIZE = 100;

/**
 * In-process retry budget for one apply (audit P0-2). Three attempts total; the
 * delays sit between them. Short on purpose: a transient blip (deadlock, pool
 * timeout, a slow `linkOrphanRecords`) recovers silently, anything structural
 * blocks the topic instead of dropping the change.
 */
export const APPLY_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 3_000];
export const APPLY_ATTEMPTS = APPLY_RETRY_DELAYS_MS.length;

/** Close the `cdc` sync run once every topic has been down this long. */
const SYNC_RUN_IDLE_CLOSE_MS = Number(process.env.CDC_RUN_IDLE_CLOSE_MS ?? 30_000);
const SYNC_RUN_WATCHDOG_MS = 5_000;
/** Cap on the per-run latency reservoir (p50/max of `latency_ms`). */
const MAX_LATENCY_SAMPLES = 10_000;

// --------------------------------------------------------------- proto loading

let definitionPromise: Promise<any> | null = null;

/** Load `eventbus.v1.PubSub` from the vendored proto (cached). */
export async function loadProto(): Promise<any> {
  if (!definitionPromise) {
    definitionPromise = (async () => {
      const definition = await protoLoader.load(PROTO_PATH, PROTO_OPTIONS);
      const loaded = grpc.loadPackageDefinition(definition) as any;
      const service = loaded?.eventbus?.v1?.PubSub;
      if (!service) throw new Error(`eventbus.v1.PubSub not found in ${PROTO_PATH}`);
      return service;
    })().catch((error: unknown) => {
      definitionPromise = null;
      throw error;
    });
  }
  return definitionPromise;
}

function createCredentials(): grpc.ChannelCredentials {
  return sfUseMock() ? grpc.credentials.createInsecure() : grpc.credentials.createSsl();
}

function clientOptions(): grpc.ClientOptions {
  return {
    'grpc.keepalive_time_ms': 30_000,
    'grpc.keepalive_timeout_ms': 10_000,
    'grpc.max_receive_message_length': 32 * 1024 * 1024,
  };
}

/**
 * Pub/Sub auth metadata. The mock ignores it; a real org needs the OAuth token
 * (`accesstoken`), the instance URL and the org id (`tenantid`).
 */
export async function authMetadata(): Promise<grpc.Metadata> {
  const metadata = new grpc.Metadata();
  if (sfUseMock()) return metadata;
  const token = await getAccessToken();
  metadata.set('accesstoken', token);
  const instanceUrl = process.env.SF_INSTANCE_URL?.trim();
  if (instanceUrl) metadata.set('instanceurl', instanceUrl);
  const tenantId = process.env.SF_TENANT_ID?.trim();
  if (tenantId) metadata.set('tenantid', tenantId);
  return metadata;
}

/** New Pub/Sub client. Call `.close()` when done. */
export async function createPubSubClient(): Promise<any> {
  const Ctor = await loadProto();
  return new Ctor(pubsubEndpoint(), createCredentials(), clientOptions());
}

// -------------------------------------------------------------- replay ids

export function decodeReplayId(value: unknown): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
  if (buffer.length === 0) return 0n;
  if (buffer.length === 8) return buffer.readBigInt64BE(0);
  const padded = Buffer.alloc(8);
  buffer.copy(padded, Math.max(0, 8 - buffer.length));
  return padded.readBigInt64BE(0);
}

export function encodeReplayId(value: bigint | number | string): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(value));
  return buffer;
}

// ------------------------------------------------------------------- schemas

export interface DecodedChangeEvent {
  ChangeEventHeader: {
    entityName: string;
    recordIds: string[];
    changeType: string;
    changedFields?: string[];
    nulledFields?: string[];
    diffFields?: string[];
    commitTimestamp?: number;
    commitNumber?: number;
    sequenceNumber?: number;
    commitUser?: string;
    transactionKey?: string;
    changeOrigin?: string;
    isTransactionEnd?: boolean;
  };
  [field: string]: unknown;
}

const schemaCache = new Map<string, avro.Type>();

/** Build (and cache) an avsc Type from the schema JSON returned by GetSchema. */
export function schemaToType(schemaJson: string, cacheKey?: string): avro.Type {
  if (cacheKey) {
    const hit = schemaCache.get(cacheKey);
    if (hit) return hit;
  }
  const type = avro.Type.forSchema(JSON.parse(schemaJson) as avro.Schema);
  if (cacheKey) schemaCache.set(cacheKey, type);
  return type;
}

/**
 * Fetch the Avro schema for `schemaId` via `GetSchema` (in-memory cached).
 * An empty schema id resolves to the mock's default (Account) schema, exactly
 * like the server does.
 */
export async function fetchSchema(client: any, schemaId: string): Promise<avro.Type> {
  const key = schemaId || '__default__';
  const cached = schemaCache.get(key);
  if (cached) return cached;

  const info = await new Promise<any>((resolve, reject) => {
    client.getSchema({ schemaId: schemaId ?? '' }, (error: any, response: any) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
  const schemaJson = String(info?.schemaJson ?? '');
  if (!schemaJson) throw new Error(`GetSchema returned no schema for id "${schemaId}"`);
  return schemaToType(schemaJson, key);
}

/** Decode one Avro CDC payload. The top-level `Id` is NOT in the schema. */
export function decodeChangeEvent(
  payload: Buffer | Uint8Array | string,
  schema: avro.Type,
): DecodedChangeEvent {
  const buffer =
    typeof payload === 'string'
      ? Buffer.from(payload, 'binary')
      : Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(payload);
  return schema.fromBuffer(buffer) as unknown as DecodedChangeEvent;
}

/**
 * Merge the record id from `ChangeEventHeader.recordIds[0]` into the payload so
 * `applySalesforceRecord` (which keys on `Id`) can consume it.
 */
export function toSalesforceRecord(datum: DecodedChangeEvent): SalesforceRecord {
  const header = datum.ChangeEventHeader ?? ({} as DecodedChangeEvent['ChangeEventHeader']);
  const recordIds = Array.isArray(header.recordIds) ? header.recordIds.map(String) : [];
  const record: SalesforceRecord = { ...(datum as Record<string, unknown>), Id: recordIds[0] ?? '' };
  return record;
}

// -------------------------------------------------------------- event shape

export type CdcOutcome = 'applied' | 'skipped_stale' | 'ignored' | 'failed' | 'duplicate';

export interface CdcEventLog {
  topic: string;
  channel: string;
  object: string;
  changeType: string;
  sfId: string;
  replayId: string;
  latencyMs: number | null;
  outcome: CdcOutcome;
  eventId: string;
}

export interface ConsumerStats {
  events: number;
  applied: number;
  skipped_stale: number;
  ignored: number;
  failed: number;
  duplicates: number;
  reconnects: number;
  /** Events that exhausted the retry budget and blocked their topic. */
  blocked: number;
  /** Events dropped (not recorded) because they sit behind a blocked event. */
  held: number;
  lastEventAt: string | null;
  lastReplayId: string | null;
}

export interface ConsumerOptions {
  /** Topics to subscribe to. Defaults to the four CDC topics from env. */
  topics?: string[];
  /** Checkpoint channel per topic. Defaults to the topic name. */
  channelForTopic?: (topic: string) => string;
  log?: (line: string) => void;
  onEvent?: (info: CdcEventLog) => void;
  batchSize?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * Close the `cdc` sync run once every topic has been disconnected this long
   * (default `CDC_RUN_IDLE_CLOSE_MS` or 30 000 ms). A fresh run opens on the
   * next live subscription.
   */
  syncRunIdleCloseMs?: number;
  /** How often the idle check runs (default 5 000 ms). */
  syncRunWatchdogMs?: number;
}

interface Runner {
  topic: string;
  channel: string;
  stream: grpc.ClientDuplexStream<any, any> | null;
  client: any | null;
  queue: Promise<void>;
  attempt: number;
  stopped: boolean;
  highestSaved: bigint;
  wake: (() => void) | null;
  connected: boolean;
  /** Resolves on the first FetchResponse (i.e. the subscription is live). */
  ready: Promise<void>;
  markReady: () => void;
  /**
   * Replay id of the event this topic is blocked on (it could not be applied).
   * `null` = healthy. Anything **after** it is dropped unrecorded and re-fetched
   * by the replay, so the checkpoint never jumps over the poison event.
   */
  blockedAt: bigint | null;
  /** When this topic's stream last went down (`null` while connected). */
  disconnectedAt: number | null;
}

const DEFAULT_LOG = (line: string) => console.log(line);

function sleepUnlessStopped(runner: Runner, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      runner.wake = null;
      resolve();
    }, ms);
    runner.wake = () => {
      clearTimeout(timer);
      runner.wake = null;
      resolve();
    };
  });
}

function backoffDelay(attempt: number, minMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 10));
  const jitter = 0.5 + Math.random(); // 0.5x … 1.5x
  return Math.max(minMs, Math.min(maxMs, Math.round(exponential * jitter)));
}

/**
 * 
 */

/**
 * p50 / max of the per-run `latency_ms` reservoir (`latency_ms` is
 * `now - ChangeEventHeader.commitTimestamp`, so it includes reconnect backoff).
 */
export function summariseLatency(samples: readonly number[]): {
  p50: number | null;
  max: number | null;
  samples: number;
} {
  const values = samples.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (values.length === 0) return { p50: null, max: null, samples: 0 };
  const middle = Math.floor(values.length / 2);
  const p50 =
    values.length % 2 === 0 ? Math.round((values[middle - 1] + values[middle]) / 2) : values[middle];
  return { p50, max: values[values.length - 1], samples: values.length };
}

function isoFromCommit(commitTimestamp: unknown): string {
  const value = Number(commitTimestamp);
  if (Number.isFinite(value) && value > 0) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

/**
 * Stored status of an already-recorded CDC event (`null` when unknown).
 *
 * Used on the duplicate path: a `failed` row means the event is coming back from
 * a replay of a blocked checkpoint and must be re-applied, not skipped.
 *
 * A tiny read through `@poc/core`'s `queryOne` (the same escape hatch
 * `reconcile.ts` uses) because `listCdcEvents({status:'failed'})` is paginated
 * and could miss the event when many are dead-lettered.
 */
async function existingCdcEventStatus(eventId: string): Promise<string | null> {
  const row = await queryOne<{ status: string }>(
    `SELECT status FROM cdc_events WHERE event_id = $1`,
    [eventId],
  );
  return row?.status ?? null;
}

/**
 * Mark a CDC event resolved **and** clear the error text a previous attempt
 * left behind, so a re-applied / redriven row reads clean.
 */
export async function markEventResolved(
  eventId: string,
  status: 'applied' | 'skipped_stale' | 'ignored',
): Promise<void> {
  await markCdcEventProcessed(eventId, status);
  await query(
    `UPDATE cdc_events SET error = NULL WHERE event_id = $1 AND error IS NOT NULL`,
    [eventId],
  ).catch(() => undefined);
}

// ------------------------------------------------------------------ consumer

export class CdcConsumer {
  readonly topics: string[];
  /**
   * Identity of this consumer lifetime, stamped into the `cdc` sync run's
   * `details.instance` so an orphaned run can be traced back to a process.
   */
  readonly instanceId = randomUUID();
  readonly stats: ConsumerStats = {
    events: 0,
    applied: 0,
    skipped_stale: 0,
    ignored: 0,
    failed: 0,
    duplicates: 0,
    reconnects: 0,
    blocked: 0,
    held: 0,
    lastEventAt: null,
    lastReplayId: null,
  };

  private readonly runners: Runner[];
  private readonly loops: Promise<void>[] = [];
  private readonly log: (line: string) => void;
  private readonly onEvent: ((info: CdcEventLog) => void) | undefined;
  private readonly batchSize: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly syncRunIdleCloseMs: number;
  private readonly syncRunWatchdogMs: number;
  private stopped = false;

  // ---- cdc sync run (audit P1-3): one row per consumer lifetime/reconnect ----
  /** `sync_runs.id` of the currently open `cdc` run, or `null`. */
  private syncRunId: string | null = null;
  private syncRunStartedAt = 0;
  private syncRunsCompleted = 0;
  /** Serialises open/close so the start/stop race cannot duplicate a run. */
  private runOps: Promise<void> = Promise.resolve();
  /** Stats snapshot at run open, so each run reports its own deltas. */
  private runBaseline = { ...CdcConsumer.zeroCounters() };
  private latencySamples: number[] = [];
  private watchdog: NodeJS.Timeout | null = null;

  private static zeroCounters() {
    return { events: 0, applied: 0, skipped_stale: 0, ignored: 0, failed: 0, duplicates: 0, blocked: 0, held: 0 };
  }

  constructor(options: ConsumerOptions = {}) {
    const topics = [...new Set(options.topics?.length ? options.topics : defaultTopics())].filter(
      (topic) => typeof topic === 'string' && topic.trim() !== '',
    );
    if (topics.length === 0) throw new Error('startConsumer requires at least one topic');

    const backoff = backoffConfig();
    this.topics = topics;
    this.log = options.log ?? DEFAULT_LOG;
    this.onEvent = options.onEvent;
    this.batchSize =
      options.batchSize ?? Number(process.env.PUBSUB_NUM_REQUESTED ?? DEFAULT_BATCH_SIZE);
    this.minBackoffMs = options.minBackoffMs ?? backoff.minMs;
    this.maxBackoffMs = options.maxBackoffMs ?? backoff.maxMs;
    this.syncRunIdleCloseMs = options.syncRunIdleCloseMs ?? SYNC_RUN_IDLE_CLOSE_MS;
    this.syncRunWatchdogMs = options.syncRunWatchdogMs ?? SYNC_RUN_WATCHDOG_MS;
    this.runners = topics.map((topic) => {
      let markReady = () => undefined as void;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      return {
        topic,
        channel: options.channelForTopic ? options.channelForTopic(topic) : topic,
        stream: null,
        client: null,
        queue: Promise.resolve(),
        attempt: 0,
        stopped: false,
        highestSaved: 0n,
        wake: null,
        connected: false,
        ready,
        markReady,
        blockedAt: null,
        disconnectedAt: null,
      };
    });
  }

  /**
   * Resolve once every topic has received its first FetchResponse, i.e. the
   * subscription is live and the mock will deliver subsequent events.
   * Call this before emitting if you want to observe your own subscription.
   */
  async ready(timeoutMs = 10_000): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`consumer did not subscribe within ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.all(this.runners.map((runner) => runner.ready)), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Start one reconnect loop per topic. Resolves once the loops are running. */
  start(): void {
    if (this.stopped) throw new Error('consumer already stopped');
    // One `cdc` sync run per consumer lifetime (audit P1-3): the dashboard reads
    // `sync_runs` to decide between "Running" and "Idle".
    this.openSyncRun();
    this.watchdog = setInterval(() => this.checkSyncRunIdle(), this.syncRunWatchdogMs);
    this.watchdog.unref?.();
    for (const runner of this.runners) {
      const loop = this.runTopic(runner);
      this.loops.push(loop);
    }
    this.log(
      `[cdc] consumer started topics=${this.topics.length} endpoint=${pubsubEndpoint()} ` +
        `mode=${sfUseMock() ? 'mock' : 'real'}`,
    );
  }

  /** Stop every stream, let in-flight events finish, and return. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    for (const runner of this.runners) {
      runner.stopped = true;
      runner.wake?.();
      try {
        runner.stream?.cancel();
      } catch {
        /* stream already closed */
      }
    }
    await Promise.allSettled(this.loops);
    await Promise.allSettled(this.runners.map((runner) => runner.queue));
    await this.closeSyncRun('consumer stopped');
    this.log('[cdc] consumer stopped');
  }

  // --------------------------------------------------------- cdc sync runs

  /** Open the `cdc` sync run if none is open. Fire-and-forget, serialised. */
  private openSyncRun(): void {
    this.runOps = this.runOps.then(async () => {
      if (this.stopped || this.syncRunId !== null) return;
      try {
        const id = await startSyncRun('cdc', {
          source: 'pubsub',
          instance: this.instanceId,
          topics: this.topics,
          started_at: new Date().toISOString(),
        });
        this.syncRunId = id;
        this.syncRunStartedAt = Date.now();
        this.runBaseline = { ...this.currentCounters() };
        this.latencySamples = [];
        this.log(`[cdc] sync_run=${id} open kind=cdc topics=${this.topics.length}`);
      } catch (error) {
        this.log(`[cdc] could not open a cdc sync run: ${this.describe(error)}`);
      }
    });
  }

  /**
   * Close a `cdc` sync run left `running` by a **dead** consumer process.
   *
   * This is deliberately *not* called automatically: a second consumer in the
   * same process (or a test process sharing the database) must not close the
   * run of a live one. `apps/worker` calls it once at startup, where "any
   * `running` cdc run is a previous incarnation" holds by construction.
   */
  static async reapOrphanSyncRuns(log: (line: string) => string | void = DEFAULT_LOG): Promise<number> {
    const reaped = await query<{ id: string }>(
      `UPDATE sync_runs
          SET status = 'failed',
              finished_at = now(),
              error = COALESCE(error, 'orphaned: the consumer that owned this run is gone'),
              details = COALESCE(details, '{}'::jsonb)
                        || jsonb_build_object('close_reason', 'orphaned')
        WHERE kind = 'cdc' AND status = 'running'
        RETURNING id`,
    );
    if (reaped.length > 0) {
      log(`[cdc] reaped ${reaped.length} orphaned cdc sync run(s) from a previous consumer`);
    }
    return reaped.length;
  }

  /** Close the open `cdc` sync run with this run's own counters and latency. */
  private closeSyncRun(reason: string): Promise<void> {
    this.runOps = this.runOps.then(async () => {
      const id = this.syncRunId;
      if (id === null) return;
      this.syncRunId = null;
      this.syncRunsCompleted += 1;

      const now = this.currentCounters();
      const base = this.runBaseline;
      const delta = {
        events: now.events - base.events,
        applied: now.applied - base.applied,
        skipped_stale: now.skipped_stale - base.skipped_stale,
        ignored: now.ignored - base.ignored,
        failed: now.failed - base.failed,
        duplicates: now.duplicates - base.duplicates,
        blocked: now.blocked - base.blocked,
        held: now.held - base.held,
      };
      const latency = summariseLatency(this.latencySamples);
      const details = {
        source: 'pubsub',
        topics: this.topics,
        applied: delta.applied,
        skipped_stale: delta.skipped_stale,
        ignored: delta.ignored,
        failed: delta.failed,
        duplicates: delta.duplicates,
        blocked: delta.blocked,
        held: delta.held,
        events: delta.events,
        latency_ms: { p50: latency.p50, max: latency.max, samples: latency.samples },
        duration_ms: Date.now() - this.syncRunStartedAt,
        reconnects: this.stats.reconnects,
        close_reason: reason,
      };
      const failed = delta.failed > 0;
      this.latencySamples = [];
      try {
        await finishSyncRun(id, {
          status: failed ? 'failed' : 'success',
          records_read: delta.events,
          records_written: delta.applied,
          ...(failed
            ? {
                error:
                  `${delta.failed} CDC event(s) could not be applied after ` +
                  `${APPLY_ATTEMPTS} attempts (checkpoint blocked)`,
              }
            : {}),
          details,
        });
        this.log(
          `[cdc] sync_run=${id} closed status=${failed ? 'failed' : 'success'} (${reason}) ` +
            `read=${delta.events} written=${delta.applied} failed=${delta.failed} ` +
            `latency_p50=${latency.p50 ?? 'n/a'} latency_max=${latency.max ?? 'n/a'}`,
        );
      } catch (error) {
        this.log(`[cdc] could not close cdc sync run ${id}: ${this.describe(error)}`);
      }
    });
    return this.runOps;
  }

  /** Nothing has been subscribed for a while → this run is over, close it. */
  private checkSyncRunIdle(): void {
    if (this.stopped || this.syncRunId === null) return;
    const now = Date.now();
    const down = this.runners.every(
      (runner) =>
        runner.disconnectedAt !== null && now - runner.disconnectedAt >= this.syncRunIdleCloseMs,
    );
    if (down) {
      this.log(
        `[cdc] every topic has been disconnected for ≥${Math.round(this.syncRunIdleCloseMs / 1000)}s ` +
          `— closing the cdc sync run (a new one opens on the next successful subscribe)`,
      );
      void this.closeSyncRun('disconnected');
    }
  }

  private currentCounters() {
    const { events, applied, skipped_stale, ignored, failed, duplicates, blocked, held } = this.stats;
    return { events, applied, skipped_stale, ignored, failed, duplicates, blocked, held };
  }

  // ------------------------------------------------------------ topic loop

  private async runTopic(runner: Runner): Promise<void> {
    while (!runner.stopped) {
      try {
        await this.subscribeOnce(runner);
      } catch (error) {
        // subscribeOnce resolves on stream end and never throws for stream
        // errors; anything landing here is a setup failure (proto, auth, ...).
        runner.connected = false;
        this.log(`[cdc] ${runner.topic} stream setup failed: ${this.describe(error)}`);
      }
      if (runner.stopped) break;

      runner.disconnectedAt = runner.disconnectedAt ?? Date.now();
      runner.attempt += 1;
      this.stats.reconnects += 1;
      const delay = backoffDelay(runner.attempt - 1, this.minBackoffMs, this.maxBackoffMs);
      this.log(
        `[cdc] ${runner.topic} reconnecting in ${delay}ms ` +
          `(attempt ${runner.attempt}, channel=${runner.channel})`,
      );
      await sleepUnlessStopped(runner, delay);
    }
  }

  private describe(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  /** Read the checkpoint and subscribe from there. Resolves when the stream dies. */
  private async subscribeOnce(runner: Runner): Promise<void> {
    const checkpoint = await getCheckpoint(runner.channel).catch(() => null);
    const previous = checkpoint?.replay_id ? BigInt(checkpoint.replay_id) : 0n;
    if (previous > runner.highestSaved) runner.highestSaved = previous;

    const client = await createPubSubClient();
    const metadata = await authMetadata();
    runner.client = client;

    return new Promise<void>((resolve) => {
      let settled = false;
      let stream: grpc.ClientDuplexStream<any, any> | null = null;

      const finish = (reason: string): void => {
        if (settled) return;
        settled = true;
        runner.connected = false;
        runner.disconnectedAt = runner.disconnectedAt ?? Date.now();
        runner.stream = null;
        runner.client = null;
        try {
          stream?.cancel();
        } catch {
          /* already gone */
        }
        try {
          client.close();
        } catch {
          /* already closed */
        }
        if (!runner.stopped) this.log(`[cdc] ${runner.topic} stream closed (${reason})`);
        resolve();
      };

      void (async () => {
        try {
          const active = client.subscribe(metadata);
          stream = active;
          runner.stream = active;

          active.on('data', (response: any) => {
            runner.connected = true;
            // A blocked topic keeps escalating its reconnect backoff (1s → 30s)
            // instead of hammering the poison event every second; the reset
            // happens as soon as that event finally applies.
            if (runner.blockedAt === null) runner.attempt = 0;
            runner.disconnectedAt = null;
            runner.markReady();
            // A live subscription means this consumer is syncing again: the
            // first subscribe opened the run, a reconnect reopens a fresh one.
            this.openSyncRun();
            const events: any[] = Array.isArray(response?.events) ? response.events : [];
            for (const event of events) {
              runner.queue = runner.queue.then(() => this.handleEvent(runner, event));
            }
            if (events.length > 0) {
              runner.queue = runner.queue.then(() => {
                // Replenish flow-control credit once the batch is processed
                // (a real org stops sending without it; the mock ignores it).
                try {
                  if (!runner.stopped && active.writable) {
                    active.write({ topicName: runner.topic, numRequested: events.length });
                  }
                } catch {
                  /* stream closed mid-write */
                }
              });
            }
          });

          active.on('error', (error: Error) => {
            // A cancelled stream during shutdown is expected, not an incident.
            if (!runner.stopped) {
              this.log(`[cdc] ${runner.topic} stream error: ${this.describe(error)}`);
              // While blocked we cancelled the stream ourselves: keep the
              // actionable "apply failed after N attempts" text on the row
              // instead of overwriting it with `CANCELLED on client`.
              if (runner.blockedAt === null) {
                void saveCheckpoint(runner.channel, null, {
                  status: 'error',
                  error: this.describe(error).slice(0, 500),
                }).catch(() => undefined);
              }
            }
            finish('error');
          });

          active.on('end', () => finish('end'));
          active.on('close', () => finish('close'));

          const preset = previous > 0n ? REPLAY_PRESET.CUSTOM : REPLAY_PRESET.LATEST;
          active.write({
            topicName: runner.topic,
            replayPreset: preset,
            replayId: previous > 0n ? encodeReplayId(previous) : Buffer.alloc(0),
            numRequested: this.batchSize,
          });

          this.log(
            `[cdc] ${runner.topic} subscribed channel=${runner.channel} ` +
              `preset=${preset === REPLAY_PRESET.CUSTOM ? 'CUSTOM' : 'LATEST'} ` +
              `replay=${previous > 0n ? previous.toString() : 'none'} num_requested=${this.batchSize}`,
          );

          // Do not clear the error state while a dead-lettered event still blocks
          // this channel: the operator has to see it on the sync card, and a
          // reconnect alone must not make the incident look resolved.
          const blocking = await listCdcEvents({ status: 'failed', limit: 200 }).catch(
            () => [],
          );
          const blocked = blocking.filter(
            (event: { channel: string }) => event.channel === runner.channel,
          );
          if (blocked.length > 0) {
            // Derive the block from the database, never from memory: an operator
            // redrive or discard resolves the row, and the next subscribe must
            // clear the block or the topic would stay frozen until a restart.
            const oldest = blocked[blocked.length - 1]!;
            runner.blockedAt =
              oldest.replay_id === null || oldest.replay_id === undefined
                ? runner.blockedAt
                : BigInt(String(oldest.replay_id));
            await saveCheckpoint(runner.channel, null, {
              status: 'error',
              error: `blocked by ${blocked.length} failed event(s), oldest replay ${String(oldest.replay_id)}`,
            }).catch(() => undefined);
          } else {
            if (runner.blockedAt !== null) {
              this.log(
                `[cdc] ${runner.topic} unblocked (no failed events remain at ` +
                  `replay=${runner.blockedAt.toString()}), resuming`,
              );
            }
            runner.blockedAt = null;
            await saveCheckpoint(runner.channel, null, { status: 'connected', error: '' }).catch(
              () => undefined,
            );
          }
        } catch (error) {
          runner.connected = false;
          runner.disconnectedAt = runner.disconnectedAt ?? Date.now();
          this.log(`[cdc] ${runner.topic} subscribe failed: ${this.describe(error)}`);
          finish('subscribe-failed');
        }
      })();
    });
  }

  // -------------------------------------------------------- event pipeline

  private async handleEvent(runner: Runner, consumerEvent: any): Promise<void> {
    this.stats.events += 1;

    let replayId = 0n;
    let eventId = '';
    let channel = runner.channel;
    let objectName = 'Unknown';
    let changeType: ChangeType = 'UPDATE';
    let sfId = '';
    let latencyMs: number | null = null;

    try {
      replayId = decodeReplayId(consumerEvent?.replayId);

      // Head-of-line guard: this topic is blocked on an earlier replay id that
      // could not be applied. Drop this event *unrecorded* — the replay from the
      // (not advanced) checkpoint will fetch it again in order. Recording or
      // advancing it here would move the checkpoint past the poison event.
      if (runner.blockedAt !== null && replayId > runner.blockedAt) {
        this.stats.held += 1;
        this.log(
          `[cdc] ${runner.topic} replay=${replayId.toString()} held (topic blocked at ` +
            `replay=${runner.blockedAt.toString()}, not recorded, will be re-fetched)`,
        );
        return;
      }

      const producerEvent = consumerEvent?.event ?? {};
      const schemaId = String(producerEvent.schemaId ?? '');
      const schema = await fetchSchema(runner.client, schemaId).catch(
        async () => {
          // `fetchSchema` needs the client, which lives inside subscribeOnce.
          // Fall back to a temporary client for a one-off schema lookup.
          const client = await createPubSubClient();
          try {
            return await fetchSchema(client, schemaId);
          } finally {
            client.close();
          }
        },
      );

      const datum = decodeChangeEvent(producerEvent.payload, schema);
      const header = datum.ChangeEventHeader ?? ({} as DecodedChangeEvent['ChangeEventHeader']);
      const recordIds = Array.isArray(header.recordIds) ? header.recordIds.map(String) : [];

      objectName = String(header.entityName ?? 'Unknown');
      sfId = recordIds[0] ?? '';
      changeType = String(header.changeType ?? 'UPDATE').toUpperCase() as ChangeType;
      const commitTimestamp = Number(header.commitTimestamp ?? 0);
      latencyMs = commitTimestamp > 0 ? Math.max(0, Date.now() - commitTimestamp) : null;
      eventId = `${channel}:${replayId.toString()}`;

      const record: SalesforceRecord = { ...(datum as Record<string, unknown>), Id: sfId };

      const { duplicate } = await recordCdcEvent({
        event_id: eventId,
        channel,
        object_name: objectName,
        record_id: sfId || `unknown:${replayId.toString()}`,
        change_type: changeType,
        replay_id: replayId,
        payload: record,
        latency_ms: latencyMs ?? undefined,
      });

      if (duplicate) {
        // A duplicate normally means "already applied" → skip and advance. But a
        // *failed* row means this is the poison event coming back on a replay:
        // re-driving it is the whole point of not advancing the checkpoint.
        const stored = await existingCdcEventStatus(eventId);
        if (stored !== 'failed') {
          this.stats.duplicates += 1;
          await this.advanceCheckpoint(runner, replayId, header);
          this.clearBlockIfReached(runner, replayId);
          this.emitLog({ topic: runner.topic, channel, object: objectName, changeType, sfId, replayId: replayId.toString(), latencyMs, outcome: 'duplicate', eventId });
          return;
        }
        this.log(
          `[cdc] ${runner.topic} replay=${replayId.toString()} was recorded as failed ` +
            `(${eventId}) — retrying it instead of skipping as duplicate`,
        );
      }

      // Bounded in-process retry (audit P0-2). Transient blips recover here; a
      // structural failure falls through to the head-of-line block below.
      let outcome: CdcOutcome = 'ignored';
      let applyError: string | null = null;
      const applyOnce = () =>
        changeType === 'DELETE'
          ? deleteSalesforceRecord(objectName, sfId).then((result) => result.outcome)
          : applySalesforceRecord(objectName, changeType, record).then((result) => result.outcome);

      for (let attempt = 1; attempt <= APPLY_ATTEMPTS; attempt += 1) {
        try {
          outcome = await applyOnce();
          applyError = null;
          break;
        } catch (error) {
          applyError = this.describe(error);
          this.log(
            `[cdc][RETRY] topic=${runner.topic} replay=${replayId.toString()} ` +
              `${objectName} ${changeType} ${sfId || '(no id)'} ` +
              `attempt=${attempt}/${APPLY_ATTEMPTS} error=${applyError.slice(0, 200)}`,
          );
          if (attempt < APPLY_ATTEMPTS) {
            await sleepUnlessStopped(runner, APPLY_RETRY_DELAYS_MS[attempt - 1] ?? 3_000);
          }
        }
      }

      if (applyError !== null) {
        await this.blockOnFailure(runner, {
          eventId,
          replayId,
          channel,
          objectName,
          changeType,
          sfId,
          latencyMs,
          error: applyError,
        });
        return;
      }

      if (outcome === 'applied') this.stats.applied += 1;
      else if (outcome === 'skipped_stale') this.stats.skipped_stale += 1;
      else this.stats.ignored += 1;
      if (latencyMs !== null && this.latencySamples.length < MAX_LATENCY_SAMPLES) {
        this.latencySamples.push(latencyMs);
      }

      await markEventResolved(eventId, outcome).catch((error: unknown) => {
        this.log(`[cdc] markCdcEventProcessed failed for ${eventId}: ${this.describe(error)}`);
      });

      await this.advanceCheckpoint(runner, replayId, header);
      this.clearBlockIfReached(runner, replayId);
      this.emitLog({
        topic: runner.topic,
        channel,
        object: objectName,
        changeType,
        sfId,
        replayId: replayId.toString(),
        latencyMs,
        outcome,
        eventId,
      });
    } catch (error) {
      // Decoding/bookkeeping failure: never let it kill the stream.
      this.stats.failed += 1;
      const message = this.describe(error);
      if (eventId) {
        await markCdcEventProcessed(eventId, 'failed', { error: message.slice(0, 1000) }).catch(
          () => undefined,
        );
      }
      this.log(
        `[cdc] ${objectName} ${changeType} ${sfId || '(no id)'} ` +
          `replay=${replayId.toString()} outcome=failed error=${message.slice(0, 300)}`,
      );
    }
  }

  /**
   * Exhausted the retry budget: dead-letter the event, keep the checkpoint where
   * it is, and stop this topic's stream so `runTopic` re-subscribes from that
   * same checkpoint after its normal backoff (deliberate head-of-line blocking).
   */
  private async blockOnFailure(
    runner: Runner,
    info: {
      eventId: string;
      replayId: bigint;
      channel: string;
      objectName: string;
      changeType: ChangeType;
      sfId: string;
      latencyMs: number | null;
      error: string;
    },
  ): Promise<void> {
    this.stats.failed += 1;
    this.stats.blocked += 1;
    await markCdcEventProcessed(info.eventId, 'failed', {
      error: info.error.slice(0, 1000),
    }).catch((error: unknown) => {
      this.log(`[cdc] could not dead-letter ${info.eventId}: ${this.describe(error)}`);
    });

    // Surface the block on the checkpoint row WITHOUT moving `replay_id`
    // (`saveCheckpoint` keeps the stored replay id when passed `null`).
    const checkpointError =
      `apply failed after ${APPLY_ATTEMPTS} attempts, checkpoint NOT advanced ` +
      `(blocked at replay=${info.replayId.toString()}): ${info.error}`;
    await saveCheckpoint(runner.channel, null, {
      status: 'error',
      error: checkpointError.slice(0, 500),
    }).catch((error: unknown) => {
      this.log(`[cdc] could not mark checkpoint ${runner.channel} as error: ${this.describe(error)}`);
    });

    runner.blockedAt = info.replayId;

    this.log(
      `[cdc][ALERT] topic=${runner.topic} replay=${info.replayId.toString()} ` +
        `event=${info.eventId} ${info.objectName} ${info.changeType} ${info.sfId || '(no id)'} ` +
        `apply failed after ${APPLY_ATTEMPTS} attempts; checkpoint NOT advanced (blocked). ` +
        `Fix or redrive. last_error=${info.error.slice(0, 300)}`,
    );
    this.emitLog(
      {
        topic: runner.topic,
        channel: info.channel,
        object: info.objectName,
        changeType: info.changeType,
        sfId: info.sfId,
        replayId: info.replayId.toString(),
        latencyMs: info.latencyMs,
        outcome: 'failed',
        eventId: info.eventId,
      },
      info.error,
    );

    // Stop this topic's stream. `runTopic` sees the closed stream, waits its
    // normal backoff, then re-subscribes from the last good checkpoint — which
    // re-delivers this very event. Nothing behind it is skipped.
    try {
      runner.stream?.cancel();
    } catch {
      /* stream already closed */
    }
  }

  /** The blocked event finally landed: stop holding the topic back. */
  private clearBlockIfReached(runner: Runner, replayId: bigint): void {
    if (runner.blockedAt === null || replayId < runner.blockedAt) return;
    this.log(
      `[cdc] ${runner.topic} unblocked (replay=${replayId.toString()} reached the ` +
        `previously blocked replay=${runner.blockedAt.toString()})`,
    );
    runner.blockedAt = null;
  }

  /** Persist the checkpoint only after the event has been applied. */
  private async advanceCheckpoint(
    runner: Runner,
    replayId: bigint,
    header: DecodedChangeEvent['ChangeEventHeader'],
  ): Promise<void> {
    if (replayId <= runner.highestSaved) return;
    // Defensive: never write a checkpoint past an event we could not apply.
    if (runner.blockedAt !== null && replayId > runner.blockedAt) return;
    const lastEventAt = isoFromCommit(header?.commitTimestamp);
    try {
      await saveCheckpoint(runner.channel, replayId.toString(), {
        status: 'connected',
        last_event_at: lastEventAt,
      });
      runner.highestSaved = replayId;
      this.stats.lastEventAt = lastEventAt;
      this.stats.lastReplayId = replayId.toString();
    } catch (error) {
      this.log(`[cdc] checkpoint write failed for ${runner.channel}: ${this.describe(error)}`);
    }
  }

  private emitLog(info: CdcEventLog, error?: string): void {
    const latency = info.latencyMs === null ? 'n/a' : String(info.latencyMs);
    this.log(
      `[cdc] ${info.object} ${info.changeType} ${info.sfId || '(no id)'} ` +
        `replay=${info.replayId} latency=${latency} outcome=${info.outcome}` +
        (error ? ` error=${error.slice(0, 200)}` : ''),
    );
    this.onEvent?.(info);
  }
}

// ----------------------------------------------------------------- singleton
const activeConsumers = new Set<CdcConsumer>();
/** Start consuming. The returned handle exposes `stop()`. */
export async function startConsumer(options: ConsumerOptions = {}): Promise<CdcConsumer> {
  const consumer = new CdcConsumer(options);
  activeConsumers.add(consumer);
  consumer.start();
  return consumer;
}

/** Stop every consumer started in this process (SIGTERM / tests). */
export async function stopConsumer(): Promise<void> {
  const consumers = [...activeConsumers];
  activeConsumers.clear();
  await Promise.all(consumers.map((consumer) => consumer.stop()));
}

// ------------------------------------------------------- one-off stream read

export interface RawEvent {
  topic: string;
  replayId: bigint;
  schemaId: string;
  decoded: DecodedChangeEvent;
}

export interface ReadEventsOptions {
  topic: string;
  preset?: 'LATEST' | 'EARLIEST' | 'CUSTOM';
  replayId?: bigint | number | string | null;
  limit?: number;
  timeoutMs?: number;
}

/**
 * Diagnostic helper: read up to `limit` events from a topic and decode them.
 * Used by the worker tests and by `tsx src/index.ts events --topic=…`.
 */
export async function readEvents(options: ReadEventsOptions): Promise<RawEvent[]> {
  const limit = options.limit ?? 1;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const presetName = options.preset ?? 'LATEST';
  const client = await createPubSubClient();
  const metadata = await authMetadata();
  const events: RawEvent[] = [];

  return new Promise<RawEvent[]>((resolve) => {
    let done = false;
    let stream: grpc.ClientDuplexStream<any, any> | null = null;
    let schema: avro.Type | null = null;
    let schemaId = '';

    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        stream?.cancel();
      } catch {
        /* already closed */
      }
      try {
        client.close();
      } catch {
        /* already closed */
      }
      resolve(events);
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    void (async () => {
      try {
        const active = client.subscribe(metadata);
        stream = active;
        active.on('data', (response: any) => {
          void (async () => {
            for (const event of Array.isArray(response?.events) ? response.events : []) {
              try {
                const eventSchemaId = String(event?.event?.schemaId ?? '');
                if (!schema || eventSchemaId !== schemaId) {
                  schema = await fetchSchema(client, eventSchemaId);
                  schemaId = eventSchemaId;
                }
                const decoded = decodeChangeEvent(event?.event?.payload, schema);
                events.push({
                  topic: options.topic,
                  replayId: decodeReplayId(event?.replayId),
                  schemaId: eventSchemaId,
                  decoded,
                });
              } catch (error) {
                console.error('[cdc] readEvents decode failed', error);
              }
              if (events.length >= limit) {
                finish();
                return;
              }
            }
          })();
        });
        active.on('error', finish);
        active.on('end', finish);

        active.write({
          topicName: options.topic,
          replayPreset: REPLAY_PRESET[presetName],
          replayId: options.replayId ? encodeReplayId(options.replayId) : Buffer.alloc(0),
          numRequested: Math.max(1, limit),
        });
      } catch (error) {
        console.error('[cdc] readEvents failed', error);
        finish();
      }
    })();
  });
}
