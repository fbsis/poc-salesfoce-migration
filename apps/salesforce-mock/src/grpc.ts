/**
 * Salesforce Pub/Sub API mock (gRPC, port 50051).
 *
 * Uses the vendored vendor proto (`proto/pubsub_api.proto`, copied verbatim
 * from github.com/forcedotcom/pub-sub-api) — package `eventbus.v1`.
 *
 * Implemented RPCs: Subscribe (bidi stream), GetSchema, GetTopic.
 * Not implemented (gRPC returns UNIMPLEMENTED): Publish, PublishStream,
 * ManagedSubscribe — this mock only *emits* CDC events from /mock/emit.
 *
 * Replay semantics (docs/CONTRACTS.md §6):
 *  - LATEST   (default): delivers events that were emitted while no subscriber
 *               was attached (the deferred queue), then live events.
 *  - EARLIEST: replays every event still in the 1000-entry ring buffer.
 *  - CUSTOM:   replays every buffered event with replayId > replay_id.
 *  Replay ids are 8-byte big-endian signed longs. `latest_replay_id` on every
 *  FetchResponse is the tip of the stream (never rewinds).
 *
 * Flow control (`num_requested`) is accepted but NOT enforced: events are
 * delivered as soon as they exist, and the remaining requested capacity is
 * echoed back in `pending_num_requested`.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { encodeChangeEvent, findSchemaById, getSchemaForObject } from './avro';
import {
  objectFromTopic,
  decodeReplayId,
  encodeReplayId,
  topicForObject,
  type SalesforceStore,
  type SfObject,
  type StoredEvent,
} from './store';

const PROTO_PATH = fileURLToPath(new URL('../proto/pubsub_api.proto', import.meta.url));
const PROTO_OPTIONS: protoLoader.Options = {
  keepCase: false,
  longs: Number,
  enums: Number,
  defaults: true,
  oneofs: true,
};

export const DEFAULT_TOPIC_NAMES: Record<SfObject, string> = {
  Account: topicForObject('Account'),
  Contact: topicForObject('Contact'),
  Opportunity: topicForObject('Opportunity'),
  Lead: topicForObject('Lead'),
};

const TENANT_GUID = '00DMOCK000000001AAA';
const MAX_DEFERRED_EVENTS = 1000;
const KEEPALIVE_MS = 25_000;
const BATCH_SIZE = 100;

type ReplayPresetName = 'LATEST' | 'EARLIEST' | 'CUSTOM';

interface Subscriber {
  id: string;
  topic: string;
  object: SfObject;
  call: grpc.ServerDuplexStream<any, any>;
  lastReplayId: number;
  requested: number;
  delivered: number;
  keepalive: NodeJS.Timeout | null;
  closed: boolean;
}

export interface PubSubControl {
  publish(event: StoredEvent): { delivered: number; queued: boolean };
  disconnect(topic?: string): number;
  subscriberCount(topic?: string): number;
  reset(): void;
  stop(): Promise<void>;
}

export interface PubSubServerOptions {
  store: SalesforceStore;
  host?: string;
  port?: number;
}

function toRpcError(code: grpc.status, message: string): Error & { code: grpc.status; details: string } {
  const error = new Error(message) as Error & { code: grpc.status; details: string };
  error.code = code;
  error.details = message;
  return error;
}

function presetName(value: unknown): ReplayPresetName {
  if (typeof value === 'string') {
    const upper = value.toUpperCase();
    if (upper === 'EARLIEST' || upper === 'CUSTOM' || upper === 'LATEST') return upper;
    return 'LATEST';
  }
  if (value === 1) return 'EARLIEST';
  if (value === 2) return 'CUSTOM';
  return 'LATEST';
}

function asBuffer(value: unknown): Buffer {
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'binary');
  return Buffer.alloc(0);
}

export class PubSubMockServer implements PubSubControl {
  private readonly store: SalesforceStore;
  private readonly host: string;
  private readonly port: number;
  private readonly server: grpc.Server;
  private readonly subscribers = new Map<string, Subscriber[]>();
  private readonly deferred = new Map<string, StoredEvent[]>();
  private keepaliveTimer: NodeJS.Timeout | null = null;

  constructor(options: PubSubServerOptions) {
    this.store = options.store;
    this.host = options.host ?? process.env.MOCK_GRPC_HOST ?? '0.0.0.0';
    this.port = options.port ?? Number(process.env.MOCK_GRPC_PORT ?? process.env.PUBSUB_PORT ?? 50051);
    this.server = new grpc.Server();

    const loaded = grpc.loadPackageDefinition(protoLoader.loadSync(PROTO_PATH, PROTO_OPTIONS)) as any;
    const service = loaded?.eventbus?.v1?.PubSub?.service;
    if (!service) {
      throw new Error(`Could not load eventbus.v1.PubSub from ${PROTO_PATH}`);
    }
    this.server.addService(service, {
      subscribe: (call: grpc.ServerDuplexStream<any, any>) => this.handleSubscribe(call),
      getSchema: (call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) =>
        this.handleGetSchema(call, callback),
      getTopic: (call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) =>
        this.handleGetTopic(call, callback),
    });
  }

  // ------------------------------------------------------------------ start

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.bindAsync(
        `${this.host}:${this.port}`,
        grpc.ServerCredentials.createInsecure(),
        (error, boundPort) => {
          if (error) {
            reject(error);
            return;
          }
          this.keepaliveTimer = setInterval(() => this.sendKeepalives(), KEEPALIVE_MS);
          this.keepaliveTimer.unref();
          resolve(boundPort);
        },
      );
    });
  }

  async stop(): Promise<void> {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    for (const list of this.subscribers.values()) {
      for (const sub of list) this.closeSubscriber(sub, 'server shutting down');
    }
    this.subscribers.clear();
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.server.tryShutdown(done);
      setTimeout(() => {
        this.server.forceShutdown();
        done();
      }, 2000).unref();
    });
  }

  // ------------------------------------------------------- admin operations

  subscriberCount(topic?: string): number {
    if (topic) return (this.subscribers.get(topic) ?? []).length;
    let total = 0;
    for (const list of this.subscribers.values()) total += list.length;
    return total;
  }

  reset(): void {
    this.deferred.clear();
  }

  disconnect(topic?: string): number {
    const targets: Subscriber[] = [];
    for (const [topicName, list] of this.subscribers) {
      if (topic && topicName !== topic) continue;
      targets.push(...list);
    }
    for (const sub of targets) this.closeSubscriber(sub, 'simulated consumer disconnect');
    return targets.length;
  }

  publish(event: StoredEvent): { delivered: number; queued: boolean } {
    const list = this.subscribers.get(event.topic) ?? [];
    if (list.length === 0) {
      const queue = this.deferred.get(event.topic) ?? [];
      queue.push(event);
      while (queue.length > MAX_DEFERRED_EVENTS) queue.shift();
      this.deferred.set(event.topic, queue);
      return { delivered: 0, queued: true };
    }
    let delivered = 0;
    for (const sub of [...list]) {
      if (sub.closed) continue;
      if (this.writeEvents(sub, [event])) delivered += 1;
    }
    return { delivered, queued: false };
  }

  // ---------------------------------------------------------- RPC handlers

  private handleSubscribe(call: grpc.ServerDuplexStream<any, any>): void {
    let subscriber: Subscriber | null = null;

    call.on('data', (request: any) => {
      if (subscriber) {
        subscriber.requested += Number(request?.numRequested ?? 0);
        return;
      }
      try {
        subscriber = this.attachSubscriber(call, request);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[salesforce-mock] subscribe rejected: ${message}`);
        call.destroy(toRpcError(grpc.status.INVALID_ARGUMENT, message));
      }
    });

    call.on('error', () => {
      if (subscriber) this.detach(subscriber);
      subscriber = null;
    });

    call.on('end', () => {
      if (subscriber) this.detach(subscriber);
      subscriber = null;
      try {
        call.end();
      } catch {
        /* already closed */
      }
    });

    call.on('cancelled', () => {
      if (subscriber) this.detach(subscriber);
      subscriber = null;
    });
  }

  private handleGetSchema(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void {
    const schemaId = String(call.request?.schemaId ?? '').trim();
    const entry = schemaId ? findSchemaById(schemaId) : getSchemaForObject('Account');
    if (!entry) {
      callback(toRpcError(grpc.status.NOT_FOUND, `Unknown schema id: ${schemaId}`));
      return;
    }
    callback(null, {
      schemaJson: entry.schemaJson,
      schemaId: entry.schemaId,
      rpcId: randomUUID(),
    });
  }

  private handleGetTopic(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void {
    const topicName = String(call.request?.topicName ?? '').trim();
    const object = objectFromTopic(topicName);
    if (!object) {
      callback(toRpcError(grpc.status.NOT_FOUND, `Unknown topic: ${topicName || '(empty)'}`));
      return;
    }
    callback(null, {
      topicName,
      tenantGuid: TENANT_GUID,
      canPublish: false,
      canSubscribe: true,
      schemaId: getSchemaForObject(object).schemaId,
      rpcId: randomUUID(),
    });
  }

  // ------------------------------------------------------------ subscribers

  private attachSubscriber(call: grpc.ServerDuplexStream<any, any>, request: any): Subscriber {
    const topic = String(request?.topicName ?? '').trim();
    if (!topic) throw new Error('First FetchRequest must include topic_name');
    const object = objectFromTopic(topic);
    if (!object) throw new Error(`Unsupported topic: ${topic}`);

    const preset = presetName(request?.replayPreset);
    const customReplay = decodeReplayId(request?.replayId);

    // Deferred events were published while nobody listened; hand them to a
    // LATEST subscriber, and drop them for replay presets (the ring buffer is
    // authoritative in that case).
    const deferred = this.takeDeferred(topic);

    let snapshot: StoredEvent[];
    if (preset === 'EARLIEST') {
      snapshot = this.store.allEvents().filter((event) => event.topic === topic);
    } else if (preset === 'CUSTOM') {
      snapshot = this.store.eventsAfter(customReplay).filter((event) => event.topic === topic);
    } else {
      snapshot = deferred;
    }

    const subscriber: Subscriber = {
      id: randomUUID(),
      topic,
      object,
      call,
      lastReplayId: snapshot.length > 0 ? snapshot[snapshot.length - 1].replayId : customReplay,
      requested: Number(request?.numRequested ?? 0),
      delivered: 0,
      closed: false,
      keepalive: null,
    };
    subscriber.keepalive = setInterval(() => {
      if (!subscriber.closed) this.writeBatch(subscriber, []);
    }, KEEPALIVE_MS);
    subscriber.keepalive.unref();

    const list = this.subscribers.get(topic) ?? [];
    list.push(subscriber);
    this.subscribers.set(topic, list);

    console.log(
      `[salesforce-mock] subscriber ${subscriber.id.slice(0, 8)} attached to ${topic} ` +
        `(preset=${preset}, replayId=${customReplay}, buffered=${snapshot.length})`,
    );

    if (snapshot.length > 0) {
      for (let offset = 0; offset < snapshot.length; offset += BATCH_SIZE) {
        this.writeBatch(subscriber, snapshot.slice(offset, offset + BATCH_SIZE));
      }
    } else {
      // Immediate empty batch tells the client the subscription is live and
      // exposes the current tip of the stream.
      this.writeBatch(subscriber, []);
    }
    return subscriber;
  }

  private detach(subscriber: Subscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    if (subscriber.keepalive) clearInterval(subscriber.keepalive);
    subscriber.keepalive = null;
    const list = this.subscribers.get(subscriber.topic) ?? [];
    const next = list.filter((entry) => entry.id !== subscriber.id);
    if (next.length > 0) this.subscribers.set(subscriber.topic, next);
    else this.subscribers.delete(subscriber.topic);
    console.log(`[salesforce-mock] subscriber ${subscriber.id.slice(0, 8)} detached`);
  }

  private closeSubscriber(subscriber: Subscriber, reason: string): void {
    if (subscriber.closed) return;
    this.detach(subscriber);
    console.log(`[salesforce-mock] subscriber ${subscriber.id.slice(0, 8)} disconnected (${reason})`);
    try {
      subscriber.call.end();
    } catch {
      /* stream already gone */
    }
  }

  private takeDeferred(topic: string): StoredEvent[] {
    const queued = this.deferred.get(topic) ?? [];
    this.deferred.delete(topic);
    return queued;
  }

  private writeEvents(subscriber: Subscriber, events: StoredEvent[]): boolean {
    return this.writeBatch(subscriber, events);
  }

  private writeBatch(subscriber: Subscriber, events: StoredEvent[]): boolean {
    if (subscriber.closed) return false;
    try {
      subscriber.call.write({
        latestReplayId: encodeReplayId(this.store.latestReplayId),
        events: events.map((event) => this.toConsumerEvent(event)),
        rpcId: randomUUID(),
        pendingNumRequested: Math.max(0, subscriber.requested - subscriber.delivered),
      });
      subscriber.delivered += events.length;
      if (events.length > 0) {
        subscriber.lastReplayId = events[events.length - 1].replayId;
      }
      return true;
    } catch (error) {
      console.warn(
        `[salesforce-mock] write to ${subscriber.id.slice(0, 8)} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      this.detach(subscriber);
      return false;
    }
  }

  private toConsumerEvent(event: StoredEvent): Record<string, unknown> {
    return {
      event: {
        id: `${event.object}-${event.replayId}`,
        schemaId: getSchemaForObject(event.object).schemaId,
        payload: encodeChangeEvent(event),
        headers: [],
      },
      replayId: encodeReplayId(event.replayId),
    };
  }

  private sendKeepalives(): void {
    for (const list of this.subscribers.values()) {
      for (const subscriber of [...list]) this.writeBatch(subscriber, []);
    }
  }
}
