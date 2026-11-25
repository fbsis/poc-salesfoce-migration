# @poc/worker — Salesforce sync worker

Owns the two Salesforce pipelines of the POC:

| Pipeline | Code | What it does |
|---|---|---|
| Bulk API 2.0 query jobs | `packages/salesforce/src/bulk.ts` | Full extract of Account → Contact → Opportunity → Lead into Postgres |
| CDC via Pub/Sub gRPC | `packages/salesforce/src/cdc.ts` | Real-time change events, Avro-decoded, deduped, checkpointed, replayed |
| Reconciliation | `packages/salesforce/src/reconcile.ts` | Per-object count + newest `SystemModstamp` gap report |

All DB writes go through `@poc/core` (`applySalesforceBatch`,
`applySalesforceRecord`, `deleteSalesforceRecord`, `startSyncRun`,
`finishSyncRun`, `getCheckpoint`, `saveCheckpoint`, `recordCdcEvent`,
`markCdcEventProcessed`). This package contains no SQL of its own except the
reconcile aggregate, which uses `@poc/core`'s exported `query` helper.

## Modes

```bash
# one extraction pass, prints a summary, exit 0 (ok) / 1 (any per-record error)
docker compose run --rm tools pnpm --filter @poc/worker exec tsx src/index.ts bulk

# CDC consumer in the foreground (ctrl-c / SIGTERM stops it gracefully)
docker compose run --rm tools pnpm --filter @poc/worker exec tsx src/index.ts cdc

# count/newest-timestamp gap report per object
docker compose run --rm tools pnpm --filter @poc/worker exec tsx src/index.ts reconcile

# bulk (unless it succeeded < 10 min ago) then cdc — what the container runs
docker compose run --rm tools pnpm --filter @poc/worker exec tsx src/index.ts all

# bulk + reconcile, then exit
docker compose run --rm tools pnpm --filter @poc/worker exec tsx src/index.ts once
```

No argv → `WORKER_MODE` (default `all`). `docker compose up -d worker` therefore
runs `all`.

Exit codes: `0` success, `1` failure (bulk per-record errors, reconcile failure,
fatal error), `2` unknown mode.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `WORKER_MODE` | `all` | Mode when no argv is given |
| `SF_USE_MOCK` | `true` | `true` = local mock, `false` = real org |
| `SF_LOGIN_URL` | `http://salesforce-mock:4000` | OAuth base (mock) / `https://login.salesforce.com` (real) |
| `SF_INSTANCE_URL` | — | Instance URL returned by OAuth (mock sets it to the mock) |
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | mock values | OAuth app |
| `SF_USERNAME` / `SF_PASSWORD` / `SF_SECURITY_TOKEN` | — | Real org password grant (used when set) |
| `SF_API_VERSION` | `v62.0` | Bulk/SOQL API version |
| `PUBSUB_ENDPOINT` | `salesforce-mock:50051` | gRPC endpoint (real: `api.pubsub.salesforce.com:7443`) |
| `PUBSUB_TOPIC*` | the four CDC topics | Topics to subscribe to |
| `PUBSUB_TOPICS` | — | Comma-separated override of the topic list |
| `WORKER_FORCE_BULK` | `0` | `1` = always run bulk on `all`, ignoring the freshness window |
| `WORKER_BULK_SKIP_WINDOW_MS` | `600000` | Freshness window for the restart-loop guard |
| `WORKER_CDC_JSON` | `0` | `1` = also print a structured `cdc_event` JSON line |
| `DATABASE_URL` | from compose | Postgres (used by `@poc/core`) |
| `PUBSUB_MIN_BACKOFF_MS` / `PUBSUB_MAX_BACKOFF_MS` | `1000` / `30000` | Reconnect backoff bounds |

## What the logs look like

```
[worker] mode=all mock=true api=v62.0 pubsub=salesforce-mock:50051
[worker] all starting bulk extract (Account → Contact → Opportunity → Lead)
[bulk] Account read=4 applied=4 skipped_stale=0 ignored=0 errors=0 ms=634
[bulk] Contact read=6 applied=6 skipped_stale=0 ignored=0 errors=0 ms=611
[bulk] Opportunity read=6 applied=6 skipped_stale=0 ignored=0 errors=0 ms=620
[bulk] Lead read=3 applied=3 skipped_stale=0 ignored=0 errors=0 ms=608
[worker] all sync_run=70915d04-… duration=2492ms
[worker]   TOTAL       read=19 applied=19 skipped_stale=0 ignored=0 errors=0
[worker] all ok
[cdc] consumer started topics=4 endpoint=salesforce-mock:50051 mode=mock
[cdc] /data/OpportunityChangeEvent subscribed channel=/data/OpportunityChangeEvent preset=LATEST replay=none num_requested=100
[cdc] Opportunity UPDATE 006MOCK00001AAAYD2 replay=1795645444496003 latency=9 outcome=applied
[cdc] Opportunity UPDATE 006VITESTEF98ECAAA replay=1795645444496041 latency=5 outcome=skipped_stale
[cdc] /data/OpportunityChangeEvent stream closed (error)
[cdc] /data/OpportunityChangeEvent reconnecting in 1187ms (attempt 1, channel=/data/OpportunityChangeEvent)
```

Per-event line format:
`[cdc] <object> <CHANGE> <sfId> replay=<replayId> latency=<ms> outcome=<applied|skipped_stale|ignored|failed|duplicate>`

`latency_ms = Date.now() − ChangeEventHeader.commitTimestamp`.

### Failure / reconnection lines

```
[cdc] /data/OpportunityChangeEvent stream error: 14 UNAVAILABLE: ...
[cdc] /data/OpportunityChangeEvent stream closed (error)
[cdc] /data/OpportunityChangeEvent reconnecting in 1187ms (attempt 1, channel=/data/OpportunityChangeEvent)
[cdc] /data/OpportunityChangeEvent subscribed channel=/data/OpportunityChangeEvent preset=CUSTOM replay=1795645444496003 num_requested=100
```

`preset=CUSTOM` means it resumed from the persisted checkpoint; `LATEST` means
"no checkpoint yet, start at the tip".

## Trigger a CDC event manually

```bash
# 1. pick an id from the mock dataset
curl -s localhost:4000/mock/state | head -c 400
# or ask for one opportunity id directly
curl -s localhost:4000/mock/state | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).dataset.opportunities[0].Id))'

# 2. emit a real Avro CDC event over the real gRPC stream
curl -s -X POST localhost:4000/mock/emit \
  -H 'content-type: application/json' \
  -d '{"object":"Opportunity","changeType":"UPDATE","record":{"Id":"006MOCK00001AAAYD2","Name":"Skyline – Downtown tower lease renewal","StageName":"Negotiation","Amount":15000,"SystemModstamp":"2025-01-01T00:00:00.000Z"}}'
```

The response contains the assigned `replayId`, `commitTimestamp` and the computed
`changedFields`. The worker applies it within a few milliseconds.

```bash
# 3. inspect the result
docker compose exec -T postgres psql -U poc -d poc_crm \
  -c "select name, stage, amount, salesforce_id from opportunities where salesforce_id='006MOCK00001AAAYD2'"
docker compose exec -T postgres psql -U poc -d poc_crm \
  -c "select channel, replay_id, status from cdc_checkpoints"
docker compose exec -T postgres psql -U poc -d poc_crm \
  -c "select object_name, change_type, status, latency_ms from cdc_events order by id desc limit 5"
```

Emit `"changeType":"DELETE"` with just `{ "Id": … }` to exercise the delete path.

## Simulate an interruption (reconnect + replay)

```bash
# force the mock to end every matching gRPC stream
curl -s -X POST localhost:4000/mock/disconnect -H 'content-type: application/json' -d '{}'
# or a single topic
curl -s -X POST localhost:4000/mock/disconnect -H 'content-type: application/json' \
  -d '{"topic":"/data/OpportunityChangeEvent"}'

# emit while the consumer is reconnecting — these land after the reconnect
# (CUSTOM replay from the checkpoint / ring buffer), exactly once
curl -s -X POST localhost:4000/mock/emit -H 'content-type: application/json' \
  -d '{"object":"Opportunity","changeType":"UPDATE","record":{"Id":"006MOCK00001AAAYD2","StageName":"Proposal","Amount":20000}}'
```

Watch `docker compose logs -f worker`: `stream closed (error)` →
`reconnecting in …ms` → `subscribed … preset=CUSTOM replay=<last applied>` → the
new events with `outcome=applied`. No row is applied twice, because
`cdc_events.event_id = <channel>:<replayId>` is unique and duplicates are skipped.

## Shutdown

`SIGTERM`/`SIGINT` stop the consumer, wait for in-flight events, then close the
DB pool and exit `0`:

```
[worker] SIGTERM received, stopping consumer
[cdc] consumer stopped
[worker] cdc stopped: events=0 applied=0 skipped_stale=0 ignored=0 failed=0 duplicates=0 reconnects=0
```

**Caveat (verified):** `docker compose stop worker` sends SIGTERM to PID 1, which
is `pnpm`, not the worker. pnpm exits on the signal and Docker then tears down the
container, so the worker's own handler does not get to finish its log lines. The
handler itself is correct — it was verified by signalling the node process
directly (`tsx src/index.ts cdc`, then `kill -TERM`), where it exits `0` after the
lines above. Nothing is lost either way: the checkpoint is only advanced after a
row is written, and replayed events are deduped. To get a fully graceful
container stop, `docker-compose.yml` (owned by the lead) would need
`command: node --import tsx src/index.ts` or `init: true` for the `worker`
service.

## Semantics implemented

1. **Ordering.** One gRPC stream per topic; events are processed through a
   per-topic promise chain, so apply order follows replay-id order. Parents
   (Account) are extracted/subscribed alongside children, and `@poc/core` parks
   orphan Contact/Opportunity links until the Account arrives.
2. **Dedupe (at-least-once → effectively-once).** `recordCdcEvent` inserts
   `event_id = <channel>:<replayId>` with `ON CONFLICT DO NOTHING`. A duplicate
   is skipped *and the checkpoint still advances*, so a replay after a crash
   cannot get stuck.
3. **Replay.** The checkpoint (`cdc_checkpoints.replay_id`) is written **after**
   the row is applied (`saveCheckpoint` last, `replayId` monotonically
   increasing). Reconnect reads it and subscribes with `CUSTOM` + the 8-byte
   big-endian replay id; with no checkpoint it uses `LATEST`.
4. **Stale guard.** `applySalesforceRecord` compares `SystemModstamp` against
   `salesforce_updated_at` in SQL; older events become `skipped_stale`.
5. **Restart-loop guard.** `all` skips `bulk` when the newest `bulk_extract`
   sync run succeeded within `WORKER_BULK_SKIP_WINDOW_MS` (10 min) unless
   `WORKER_FORCE_BULK=1`.
6. **Idempotent bulk.** Core upserts by the unique `salesforce_id`, so a second
   extraction leaves row counts unchanged.

## Tests

```bash
docker compose run --rm tools pnpm exec vitest run apps/worker/test
docker compose run --rm tools pnpm --filter @poc/worker exec tsc --noEmit
```

`apps/worker/test/bulk.test.ts` — real Bulk API 2.0 jobs against the live mock,
insert + idempotency.
`apps/worker/test/cdc.test.ts` — real gRPC stream, real Avro decode, apply,
`latency_ms`, stale guard, and checkpoint replay after a stop/restart. Both
files clean up their own rows (`salesforce_id LIKE '006VITEST%'`, their
`cdc_events` and `cdc_checkpoints`).
