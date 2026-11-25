/**
 * End-to-end smoke test for the *CDC* half of the mock (gRPC Pub/Sub + Avro):
 *
 *   1. GetTopic + GetSchema unary calls
 *   2. Subscribe(LATEST) → /mock/emit(Opportunity UPDATE) → decode the Avro
 *      payload and assert the ChangeEventHeader + record values
 *   3. Subscribe(CUSTOM, replayId - 1) → the same event is replayed
 *   4. Subscribe again → /mock/disconnect ends the stream
 *   5. Emit with nobody attached → queued → delivered to the next subscriber
 *
 * The test is replay-safe: every assertion keys off the replay id it just
 * emitted, so repeated runs (which append to the ring buffer) still pass.
 *
 * Run inside the compose network:
 *   docker compose run --rm tools pnpm --filter @poc/salesforce-mock exec tsx scripts/smoke.ts
 */

import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';

import { decodeChangeEvent, getSchemaForObject } from '../src/avro';
import { decodeReplayId, encodeReplayId } from '../src/store';

const PROTO_PATH = fileURLToPath(new URL('../proto/pubsub_api.proto', import.meta.url));
const GRPC_ENDPOINT = process.env.PUBSUB_ENDPOINT ?? 'salesforce-mock:50051';
const REST_URL = process.env.SF_INSTANCE_URL ?? 'http://salesforce-mock:4000';
const TOPIC = process.env.PUBSUB_TOPIC_OPPORTUNITY ?? '/data/OpportunityChangeEvent';
const FALLBACK_OPPORTUNITY_ID = '006SMOKE00000001AAA';

const LOADER_OPTIONS: protoLoader.Options = {
  keepCase: false,
  longs: Number,
  enums: Number,
  defaults: true,
  oneofs: true,
};

type Json = Record<string, any>;

const loaded = grpc.loadPackageDefinition(protoLoader.loadSync(PROTO_PATH, LOADER_OPTIONS)) as Json;
const client = new loaded.eventbus.v1.PubSub(GRPC_ENDPOINT, grpc.credentials.createInsecure()) as Json;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function step(message: string): void {
  console.log(`\n[smoke] ${message}`);
}

function passed(message: string): void {
  console.log(`  PASS ${message}`);
}

function unary<T>(method: string, request: Json): Promise<T> {
  return new Promise((resolve, reject) => {
    client[method](request, (error: Error | null, response: T) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

async function rest(path: string, init?: RequestInit): Promise<Json> {
  const response = await fetch(`${REST_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()) as Json;
}

interface Collected {
  call: grpc.ClientDuplexStream<Json, Json>;
  responses: Json[];
  events: Json[];
  closed: boolean;
}

function subscribe(request: Json): Collected {
  const call = client.subscribe() as grpc.ClientDuplexStream<Json, Json>;
  const state: Collected = { call, responses: [], events: [], closed: false };
  call.on('data', (response: Json) => {
    state.responses.push(response);
    state.events.push(...(response.events ?? []));
  });
  call.on('error', () => {
    state.closed = true;
  });
  call.on('end', () => {
    state.closed = true;
  });
  call.write(request);
  return state;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

const eventReplayId = (event: Json): number => decodeReplayId(event.replayId as Uint8Array);
const findEvent = (events: Json[], replayId: number): Json | undefined =>
  events.find((event) => eventReplayId(event) === replayId);

async function waitForNoSubscribers(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const health = await rest('/mock/health');
    if (health.subscribersByTopic[TOPIC] === 0) return;
    await sleep(25);
  }
  throw new Error('subscribers did not detach in time');
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  step(`REST health at ${REST_URL}`);
  const health = await rest('/mock/health');
  assert.equal(health.status, 'ok');
  passed(`dataset: ${JSON.stringify(health.dataset)} subscribers=${health.subscribers}`);

  // Ensure there is an opportunity to update (keeps the test independent of
  // whatever dataset another agent left in the mock).
  const before = await rest('/mock/state');
  const existing = (before.dataset.opportunities[0] as Json | undefined) ?? null;
  const recordId = existing ? String(existing.Id) : FALLBACK_OPPORTUNITY_ID;
  if (!existing) {
    await rest('/mock/emit', {
      method: 'POST',
      body: JSON.stringify({
        object: 'Opportunity',
        changeType: 'CREATE',
        record: {
          Id: recordId,
          Name: 'Smoke Test Opportunity',
          StageName: 'Prospecting',
          Amount: 100000,
          Probability: 10,
          CloseDate: '2025-06-30',
          OwnerName: 'Smoke Tester',
          IsDeleted: false,
        },
      }),
    });
  }

  // 1. GetTopic / GetSchema -------------------------------------------------
  step('GetTopic + GetSchema');
  const topicInfo = await unary<Json>('getTopic', { topicName: TOPIC });
  assert.equal(topicInfo.topicName, TOPIC);
  assert.ok(topicInfo.schemaId, 'topic exposes a schema id');
  assert.equal(topicInfo.canSubscribe, true);
  const schemaInfo = await unary<Json>('getSchema', { schemaId: topicInfo.schemaId });
  const schema = JSON.parse(schemaInfo.schemaJson);
  assert.equal(schema.type, 'record');
  assert.ok(
    schema.fields.some((field: Json) => field.name === 'ChangeEventHeader'),
    'schema has ChangeEventHeader',
  );
  assert.equal(schemaInfo.schemaId, getSchemaForObject('Opportunity').schemaId);
  passed(`GetTopic schemaId=${topicInfo.schemaId.slice(0, 12)}… tenant=${topicInfo.tenantGuid}`);
  passed(`GetSchema → ${schema.name} with ${schema.fields.length - 1} object fields`);

  // 2. live emit + Avro decode ---------------------------------------------
  step(`Subscribe(LATEST) on ${TOPIC}, then emit an UPDATE`);
  const live = subscribe({ topicName: TOPIC, replayPreset: 0, numRequested: 100 });
  await waitFor(() => live.responses.length > 0, 5000, 'subscription to attach');

  const emit = await rest('/mock/emit', {
    method: 'POST',
    body: JSON.stringify({
      object: 'Opportunity',
      changeType: 'UPDATE',
      record: {
        Id: recordId,
        StageName: 'Negotiation',
        Probability: null,
        Amount: 987654.32,
      },
      commitUser: '005MOCK000000001AAA',
    }),
  });
  assert.equal(emit.ok, true);
  assert.equal(emit.delivered, 1, 'event delivered to the attached subscriber');
  assert.equal(emit.queued, false);
  assert.equal(typeof emit.replayId, 'number');

  await waitFor(() => !!findEvent(live.events, emit.replayId), 5000, 'CDC event on the live stream');
  const consumerEvent = findEvent(live.events, emit.replayId)!;
  const replayIdBytes = Buffer.from(consumerEvent.replayId as Uint8Array);
  assert.equal(replayIdBytes.length, 8, 'replay id is an 8-byte long');
  assert.equal(replayIdBytes.toString('hex'), encodeReplayId(emit.replayId).toString('hex'));
  assert.equal(emit.replayIdHex, replayIdBytes.toString('hex'));
  assert.ok(consumerEvent.event.schemaId, 'ConsumerEvent carries the schema id');

  const payload = decodeChangeEvent('Opportunity', consumerEvent.event.payload as Buffer);
  const header = payload.ChangeEventHeader;
  assert.equal(header.entityName, 'Opportunity');
  assert.deepEqual(header.recordIds, [recordId]);
  assert.equal(header.changeType, 'UPDATE');
  assert.ok(header.changedFields.includes('StageName'), 'StageName listed as changed');
  assert.ok(header.changedFields.includes('Amount'), 'Amount listed as changed');
  assert.ok(header.nulledFields.includes('Probability'), 'Probability listed as nulled');
  assert.ok(header.sequenceNumber >= 1, 'sequenceNumber increases per record');
  assert.ok(header.commitNumber >= 1, 'commitNumber increases per event');
  assert.ok(
    Math.abs(Date.now() - header.commitTimestamp) < 60_000,
    'commitTimestamp is ms epoch close to now',
  );
  assert.equal(header.changeOrigin, 'mock');
  assert.equal(header.isTransactionEnd, true);
  assert.ok(Array.isArray(header.diffFields) && header.diffFields.length > 0);
  assert.equal(payload.StageName, 'Negotiation');
  assert.equal(payload.Probability, null);
  assert.equal(payload.Amount, 987654.32);
  passed(
    `Avro decoded header: entityName=${header.entityName} recordIds=${JSON.stringify(header.recordIds)} ` +
      `changeType=${header.changeType} seq=${header.sequenceNumber} commitNumber=${header.commitNumber} ` +
      `commitTimestamp=${header.commitTimestamp}`,
  );
  passed(
    `changedFields=${JSON.stringify(header.changedFields)} nulledFields=${JSON.stringify(header.nulledFields)}`,
  );
  passed(
    `record snapshot: StageName=${payload.StageName} Amount=${payload.Amount} Probability=${payload.Probability}`,
  );

  // 3. CUSTOM replay -------------------------------------------------------
  step('Subscribe(CUSTOM, replayId - 1) → the event is replayed from the ring buffer');
  const replay = subscribe({
    topicName: TOPIC,
    replayPreset: 2,
    replayId: encodeReplayId(emit.replayId - 1),
    numRequested: 100,
  });
  await waitFor(() => !!findEvent(replay.events, emit.replayId), 5000, 'replayed event');
  const replayed = findEvent(replay.events, emit.replayId)!;
  const replayedPayload = decodeChangeEvent('Opportunity', replayed.event.payload as Buffer);
  assert.equal(replayedPayload.ChangeEventHeader.commitNumber, header.commitNumber);
  assert.equal(replayedPayload.ChangeEventHeader.sequenceNumber, header.sequenceNumber);
  passed(`replayed replayId=${emit.replayId} (same commitNumber/sequenceNumber)`);

  step('Subscribe(EARLIEST) → full ring buffer incl. the emitted event');
  const earliest = subscribe({ topicName: TOPIC, replayPreset: 1, numRequested: 100 });
  await waitFor(() => !!findEvent(earliest.events, emit.replayId), 5000, 'EARLIEST replay');
  passed(`EARLIEST replayed ${earliest.events.length} buffered event(s)`);
  earliest.call.cancel();

  const noReplay = subscribe({
    topicName: TOPIC,
    replayPreset: 2,
    replayId: encodeReplayId(emit.replayId),
    numRequested: 10,
  });
  await waitFor(() => noReplay.responses.length > 0, 5000, 'empty CUSTOM subscription');
  await sleep(200);
  assert.equal(findEvent(noReplay.events, emit.replayId), undefined, 'CUSTOM at the tip replays nothing');
  passed('CUSTOM at the tip replays nothing');

  noReplay.call.cancel();
  replay.call.cancel();
  live.call.cancel();
  await waitForNoSubscribers();

  // 4. forced disconnect ---------------------------------------------------
  step('Subscribe + /mock/disconnect → the stream ends');
  const doomed = subscribe({ topicName: TOPIC, replayPreset: 0, numRequested: 10 });
  await waitFor(() => doomed.responses.length > 0, 5000, 'subscription to attach');
  const healthBefore = await rest('/mock/health');
  assert.ok(healthBefore.subscribersByTopic[TOPIC] >= 1, 'health reports the subscriber');
  const disconnected = await rest('/mock/disconnect', {
    method: 'POST',
    body: JSON.stringify({ topic: TOPIC }),
  });
  assert.ok(disconnected.disconnected >= 1, 'at least one stream was ended');
  await waitFor(() => doomed.closed, 5000, 'stream to end');
  passed(`/mock/disconnect ended ${disconnected.disconnected} stream(s)`);
  await waitForNoSubscribers();

  // 5. deferred delivery (emit with nobody attached) -----------------------
  step('Emit with no subscriber attached → queued → delivered to the next LATEST subscriber');
  const deferredEmit = await rest('/mock/emit', {
    method: 'POST',
    body: JSON.stringify({
      object: 'Opportunity',
      changeType: 'UPDATE',
      record: { Id: recordId, StageName: 'Closed Won' },
    }),
  });
  assert.equal(deferredEmit.queued, true, 'emit was queued (nobody attached)');
  const late = subscribe({ topicName: TOPIC, replayPreset: 0, numRequested: 10 });
  await waitFor(() => !!findEvent(late.events, deferredEmit.replayId), 5000, 'deferred event');
  passed(`queued replayId=${deferredEmit.replayId} delivered on attach`);
  late.call.cancel();
  await waitForNoSubscribers();

  if (failures.length > 0) {
    console.error(`\n[smoke] FAILED (${failures.length})`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('\n[smoke] ALL CHECKS PASSED');
  }
  client.close();
  await sleep(100);
}

void main().catch((error) => {
  console.error('[smoke] fatal', error);
  process.exit(1);
});
