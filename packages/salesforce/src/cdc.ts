/**
 * Salesforce Pub/Sub API consumer (gRPC + Avro CDC) — docs/CONTRACTS.md §7.
 *
 * Proto: `packages/salesforce/proto/pubsub_api.proto`, package `eventbus.v1`,
 * service `PubSub` (vendored verbatim from forcedotcom/pub-sub-api).
 *
 * Per event, strictly in this order (at-least-once, deduped, replayable):
 *   1. decode the Avro payload with the schema from `GetSchema`
 *   2. `recordCdcEvent(<channel>:<replayId>)`      → duplicate? skip + advance checkpoint
 *   3. `applySalesforceRecord` / `deleteSalesforceRecord`
 *   4. `markCdcEventProcessed(outcome)` with `latency_ms = now - commitTimestamp`
 *   5. `saveCheckpoint(channel, replayId)` **after** the row is written
 *
 * Reconnect: exponential backoff with jitter (1s → 30s cap) resuming from the
 * persisted checkpoint. `error` never escapes the process; `end` reconnects.
 */
import { fileURLToPath } from 'node:url';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import avro from 'avsc';
import {
  applySalesforceRecord,
  deleteSalesforceRecord,
  getCheckpoint,
  markCdcEventProcessed,
  recordCdcEvent,
  saveCheckpoint,
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

function isoFromCommit(commitTimestamp: unknown): string {
  const value = Number(commitTimestamp);
  if (Number.isFinite(value) && value > 0) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

// ------------------------------------------------------------------ consumer

export class CdcConsumer {
  readonly topics: string[];
  readonly stats: ConsumerStats = {
    events: 0,
    applied: 0,
    skipped_stale: 0,
    ignored: 0,
    failed: 0,
    duplicates: 0,
    reconnects: 0,
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
  private stopped = false;

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
    this.log('[cdc] consumer stopped');
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
            runner.attempt = 0;
            runner.markReady();
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
              void saveCheckpoint(runner.channel, null, {
                status: 'error',
                error: this.describe(error).slice(0, 500),
              }).catch(() => undefined);
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

          await saveCheckpoint(runner.channel, null, { status: 'connected', error: '' }).catch(
            () => undefined,
          );
        } catch (error) {
          runner.connected = false;
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
        this.stats.duplicates += 1;
        await this.advanceCheckpoint(runner, replayId, header);
        this.emitLog({ topic: runner.topic, channel, object: objectName, changeType, sfId, replayId: replayId.toString(), latencyMs, outcome: 'duplicate', eventId });
        return;
      }

      let outcome: CdcOutcome = 'ignored';
      try {
        outcome =
          changeType === 'DELETE'
            ? (await deleteSalesforceRecord(objectName, sfId)).outcome
            : (await applySalesforceRecord(objectName, changeType, record)).outcome;
      } catch (error) {
        const message = this.describe(error);
        this.stats.failed += 1;
        await markCdcEventProcessed(eventId, 'failed', { error: message.slice(0, 1000) }).catch(
          () => undefined,
        );
        // Advance anyway: the event is already recorded as failed (dead letter),
        // and a poison event must not block the stream forever.
        await this.advanceCheckpoint(runner, replayId, header);
        this.emitLog({ topic: runner.topic, channel, object: objectName, changeType, sfId, replayId: replayId.toString(), latencyMs, outcome: 'failed', eventId }, message);
        return;
      }

      if (outcome === 'applied') this.stats.applied += 1;
      else if (outcome === 'skipped_stale') this.stats.skipped_stale += 1;
      else this.stats.ignored += 1;

      await markCdcEventProcessed(eventId, outcome).catch((error: unknown) => {
        this.log(`[cdc] markCdcEventProcessed failed for ${eventId}: ${this.describe(error)}`);
      });

      await this.advanceCheckpoint(runner, replayId, header);
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

  /** Persist the checkpoint only after the event has been applied. */
  private async advanceCheckpoint(
    runner: Runner,
    replayId: bigint,
    header: DecodedChangeEvent['ChangeEventHeader'],
  ): Promise<void> {
    if (replayId <= runner.highestSaved) return;
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
