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
| `CDC_RUN_IDLE_CLOSE_MS` | `30000` | Close the `cdc` sync run once every topic has been down this long |
| `PORT_CONTROL` | `3002` | Port of the control HTTP endpoint (below). Set by `docker-compose.yml`, published as `3002:3002` |
| `CRM_API_TOKEN` | from compose | Bearer token required by every control route |

## Control endpoint (`PORT_CONTROL`, default 3002)

The worker is normally driven by argv / `WORKER_MODE`, which cannot be triggered
from another container. `apps/worker/src/control.ts` adds a small **operational
control plane** so a test, a demo script or an operator can start the two jobs
over HTTP. It is started in *every* mode (the log line is
`[control] listening port=3002 mode=all`) and closed on shutdown.

Every route requires `Authorization: Bearer ${CRM_API_TOKEN}` (401 otherwise,
fail-closed when the token is empty).

| Method | Path | Behaviour |
|---|---|---|
| GET | `/health` | `200 { status: 'ok', mode, busy, lastBulkRun }`. `lastBulkRun` is the last bulk run *this process* executed, with `{ syncRunId, status, startedAt, finishedAt, durationMs, totals }`; after a restart it falls back to the newest `bulk_extract` row in `sync_runs` (`durationMs`/`totals` `null`). `busy` is `'bulk'`/`'reconcile'`/`'redrive'`/`null`. |
| POST | `/run/bulk` | Runs one Bulk API 2.0 extraction **synchronously** and answers `200` with the full summary: `{ jobId (= syncRunId), kind: 'bulk_extract', status, startedAt, finishedAt, durationMs, totals, objects }`. `500` with the same shape (or an error envelope) when the run reported failures. `409` when another run holds the single-flight lock. |
| POST | `/run/reconcile` | Runs one reconciliation pass: `200 { jobId, kind: 'reconcile', status, startedAt, finishedAt, durationMs, rows }`, `500` when the report is not clean. |
| POST | `/run/discard` | Abandons failed events on purpose when their *data* can never be applied. Body `{ "event_ids": ["<channel>:<replayId>"] }`. Marks them `ignored` (the row stays for audit) and moves the channel checkpoint past them so the topic drains. **The record that event described is not applied** — a later corrected `UPDATE` or a full extraction repairs it. Answers `200` with `{ discarded, not_found, checkpoint_advanced }`. |
| POST | `/run/redrive` | Re-applies `cdc_events.status='failed'` rows (see [When an event cannot be applied](#when-an-event-cannot-be-applied-p0-2)). Body is optional: `{ "limit": 50 }`. Answers `200` with the summary `{ attempted, applied, skipped_stale, ignored, still_failing }` — a non-zero `still_failing` is a *report*, not an HTTP error: the event is still broken, fix the data and redrive again. `409` when another run holds the single-flight lock. |

Synchronous on purpose: a `200` from `POST /run/bulk` means the rows are in
Postgres, so callers need no second wait/poll protocol. `GET /health` exposes the
same summary for polling and for dashboards.

```bash
# what the E2E suite does (apps/web/test/e2e/01-bulk.test.ts)
curl -s localhost:3002/health -H 'authorization: Bearer poc-local-token'
curl -s -X POST localhost:3002/run/bulk -H 'authorization: Bearer poc-local-token' \
  -H 'content-type: application/json' -d '{}'
curl -s -X POST localhost:3002/run/reconcile -H 'authorization: Bearer poc-local-token'
curl -s -X POST localhost:3002/run/redrive -H 'authorization: Bearer poc-local-token' \
  -H 'content-type: application/json' -d '{"limit":50}'
# only when the payload can never apply: drop it so the topic drains
curl -s -X POST localhost:3002/run/discard -H 'authorization: Bearer poc-local-token' \
  -H 'content-type: application/json' -d '{"event_ids":["/data/OpportunityChangeEvent:1795…"]}'
```

```
[control] listening port=3002 mode=all
[control] bulk run requested
[bulk] Account read=7 applied=7 skipped_stale=0 ignored=0 errors=0 ms=612
[control] bulk run e91c8923-… ok read=30 applied=29 skipped_stale=1 errors=0 duration=2501ms
```

The control server only *triggers* the existing pipelines: the Bulk API client,
the core upserts and `sync_runs` accounting are the same code paths as the CLI.
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

**Pinned timestamps.** `/mock/emit` normally stamps the event with "now" (so
successive events for one record always move forward). If the emitted `record`
carries an explicit `SystemModstamp`, the mock keeps it — that is how
`apps/web/test/e2e/02-cdc.test.ts` publishes an *older* event and proves the
stale-write guard (`skipped_stale`, row not regressed):

```bash
curl -s -X POST localhost:4000/mock/emit -H 'content-type: application/json' \
  -d '{"object":"Opportunity","changeType":"UPDATE","record":{"Id":"006MOCK00001AAAYD2","StageName":"Closed Lost","SystemModstamp":"2024-01-01T00:00:00.000Z"}}'
```

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
[cdc] sync_run=51d4565e-d176-40e9-b1a4-f9a330f14faf closed status=success (consumer stopped) read=3 written=3 failed=0 latency_p50=4 latency_max=5
[cdc] consumer stopped
[worker] cdc stopped: events=3 applied=3 skipped_stale=0 ignored=0 failed=0 duplicates=0 blocked=0 held=0 reconnects=0
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
   cannot get stuck — **unless** the stored row is `failed`, in which case the
   duplicate is treated as a retry (see
   [When an event cannot be applied](#when-an-event-cannot-be-applied-p0-2)).
3. **Replay.** The checkpoint (`cdc_checkpoints.replay_id`) is written **after**
   the row is applied (`saveCheckpoint` last, `replayId` monotonically
   increasing, stored as a decimal string). Reconnect reads it and subscribes
   with `CUSTOM` + the 8-byte big-endian replay id; with no checkpoint it uses
   `LATEST`. A failed apply never advances it.
4. **Stale guard.** `applySalesforceRecord` compares `SystemModstamp` against
   `salesforce_updated_at` in SQL; older events become `skipped_stale`.
5. **Restart-loop guard.** `all` skips `bulk` when the newest `bulk_extract`
   sync run succeeded within `WORKER_BULK_SKIP_WINDOW_MS` (10 min) unless
   `WORKER_FORCE_BULK=1`.
6. **Idempotent bulk.** Core upserts by the unique `salesforce_id`, so a second
   extraction leaves row counts unchanged.

## When an event cannot be applied (P0-2)

An apply that throws is **retried in-process**: 3 attempts, 250 ms / 1 s / 3 s
backoff, each attempt logged as `[cdc][RETRY] … attempt=n/3`. Transient blips
(deadlock, pool timeout, a slow `linkOrphanRecords`) recover silently.

If all 3 attempts fail the event is **dead-lettered and the checkpoint is not
advanced**:

```
[cdc][RETRY] topic=/data/OpportunityChangeEvent replay=1795654000608003 Opportunity UPDATE 006MOCK00002AAAYD2 attempt=3/3 error=unmapped StageName: "Closed Won – Renewal"
[cdc][ALERT] topic=/data/OpportunityChangeEvent replay=1795654000608003 event=/data/OpportunityChangeEvent:1795654000608003 Opportunity UPDATE 006MOCK00002AAAYD2 apply failed after 3 attempts; checkpoint NOT advanced (blocked). Fix or redrive. last_error=unmapped StageName: "Closed Won – Renewal"
[cdc] /data/OpportunityChangeEvent stream error: 1 CANCELLED: Cancelled on client
[cdc] /data/OpportunityChangeEvent stream closed (error)
[cdc] /data/OpportunityChangeEvent reconnecting in 1206ms (attempt 1, channel=/data/OpportunityChangeEvent)
[cdc] /data/OpportunityChangeEvent subscribed channel=/data/OpportunityChangeEvent preset=CUSTOM replay=1795654000608002 num_requested=100
[cdc] /data/OpportunityChangeEvent replay=1795654000608003 was recorded as failed (/data/OpportunityChangeEvent:1795654000608003) — retrying it instead of skipping as duplicate
```

So, in order:

1. `cdc_events.status='failed'` with the payload **and** the error kept;
2. `cdc_checkpoints.replay_id` **unchanged**, `status='error'`, `error` = the
   apply error (the `replay_id` never moves again until the event applies);
3. that topic's stream is cancelled and re-subscribed from the same checkpoint
   after the normal jittered backoff.

**This is deliberate head-of-line blocking, not an oversight.** One unappliable
event stops *its* topic (the other three topics keep flowing) until the event
applies. Nothing is ever skipped: an event behind the blocked replay id is
dropped *unrecorded* and re-fetched by the replay, so the checkpoint can never
jump over the hole. The alternative — the old "advance anyway, it is a dead
letter" behaviour — loses a Salesforce change forever while
`/api/crm/sync/status` still reports `failedEvents: 1` and the dashboard looks
healthy. Bounded and visible beats silently wrong for a CRM sync.

While a topic is blocked the reconnect backoff keeps growing (1 s → 30 s with
jitter) so retries do not hammer, and each retry writes the same
`[cdc][ALERT]` line. Because the event is re-delivered on every reconnect, a
`failed` row is retried even though `event_id` already exists: the duplicate
check re-drives a stored `failed` row instead of skipping it.

### Recovering: `POST /run/redrive`

A poison event whose *data* is unpalatable (an unmapped `StageName`, a constraint
violation) never heals by itself. `redriveFailedEvents()` reads every
`cdc_events.status='failed'` row, oldest first, and re-applies it with the stored
`payload` + `change_type` through the same `@poc/core` functions, **bypassing the
duplicate check** (this is not a new event, it is a known one). Each success
moves the row `failed → applied|skipped_stale|ignored` and clears its error text.

```bash
docker compose exec -T postgres psql -U poc -d poc_crm \
  -c "select event_id, status, error from cdc_events where status='failed'"

# still broken -> the event is reported, the row stays failed
curl -s -X POST localhost:3002/run/redrive -H 'authorization: Bearer poc-local-token'
# {"attempted":1,"applied":0,"skipped_stale":0,"ignored":0,"still_failing":1}

# fix the data (re-emit a valid UPDATE, repair the payload, or fix the mapping), then
curl -s -X POST localhost:3002/run/redrive -H 'authorization: Bearer poc-local-token'
# {"attempted":1,"applied":1,"skipped_stale":0,"ignored":0,"still_failing":0}
```

After a successful redrive the consumer is still blocked in memory at that
replay id until its next reconnect (≤ the current backoff, at most 30 s); the
replay then re-delivers the event, the stored row is now `applied`, so it is
skipped as a duplicate **and the checkpoint advances** — the topic drains and
everything behind the poison event is applied in order:

```
[cdc] /data/OpportunityChangeEvent unblocked (replay=1795654000608003 reached the previously blocked replay=1795654000608003)
[cdc] Opportunity UPDATE 006MOCK00002AAAYD2 replay=1795654000608003 latency=2485 outcome=duplicate
```

There is deliberately **no automatic redrive loop**: a poison event is a data or
code defect, and retrying it forever in the background hides the defect. Alerts
in the log plus a `failed` counter in `/api/crm/sync/status` are the signal.

## `cdc` sync runs (P1-3)

The consumer owns **one `sync_runs` row of kind `cdc` per lifetime**, so
`GET /api/crm/sync/status` answers `running: true` and the dashboard shows
"Running" instead of the grey "Idle" pill while checkpoints are live:

```
[cdc] sync_run=41ee3c99-d884-498e-a570-ac7ca30a528f open kind=cdc topics=4
[cdc] sync_run=41ee3c99-d884-498e-a570-ac7ca30a528f closed status=failed (consumer stopped) read=7 written=3 failed=4 latency_p50=3 latency_max=15
```

Opened on `start()`, closed on `stop()` — or after **every** topic has been
disconnected for `CDC_RUN_IDLE_CLOSE_MS` (default 30 s), so a worker that cannot
reach Pub/Sub does not report itself as running forever. The next successful
subscribe opens a fresh run. It is not one run per event and not one per
reconnect-while-connected.

Docker sends SIGTERM to `pnpm`, not to node (see [Shutdown](#shutdown)), so a
container restart can kill node before the graceful close runs and leave a
`running` row behind. `apps/worker` therefore reaps orphans **once at consumer
startup** (`CdcConsumer.reapOrphanSyncRuns()`, which closes every stale
`kind='cdc'`/`status='running'` row as `failed` with
`close_reason: 'orphaned'`). It is not called from the consumer itself: a second
consumer in the same process (or a test process sharing the database) must never
close the run of a live one.

The run is closed as `success`, or as `failed` (with `error` naming the count)
when an event was dead-lettered during it — a run where data was lost must not
look healthy. `details`:

```json
{
  "source": "pubsub", "topics": ["…"],
  "applied": 3, "skipped_stale": 0, "ignored": 0, "failed": 0,
  "duplicates": 0, "blocked": 0, "held": 0, "events": 3,
  "latency_ms": { "p50": 3, "max": 15, "samples": 3 },
  "duration_ms": 41201, "reconnects": 1, "close_reason": "consumer stopped"
}
```

`records_read` = events received, `records_written` = applied.
`latency_ms` is `now − ChangeEventHeader.commitTimestamp` for the events of that
run, so it includes reconnect/backoff time for replayed events.

## Bulk query job wire contract

`packages/salesforce/src/bulk.ts` speaks the real Bulk API 2.0 **query** job
shape (`docs/CONTRACTS.md` §6 "Bulk query jobs (corrected)"):

```
POST /services/data/v62.0/jobs/query      { operation:'query', query: SOQL, contentType:'CSV' }  → UploadComplete
GET  /services/data/v62.0/jobs/query/:id  poll → InProgress → JobComplete
GET  /services/data/v62.0/jobs/query/:id/results   CSV, paged by Sforce-Query-Locator (?locator=)
```

There is **no batch upload** (that is ingest-only) and the results CSV header is
exactly the `SELECT` list — no `sf__Id` / `sf__Created`. Pages of up to 2000 rows
are concatenated before parsing, so a multi-page result is one record list.

## Tests

```bash
docker compose run --rm tools pnpm exec vitest run apps/worker/test
docker compose run --rm tools pnpm --filter @poc/worker exec tsc --noEmit
```

The end-to-end proof of the control endpoint (and of both pipelines over HTTP)
lives in `apps/web/test/e2e` — see
[`apps/web/test/e2e/README.md`](../../web/test/e2e/README.md).

`apps/worker/test/bulk.test.ts` — real Bulk API 2.0 **query** jobs against the
live mock: the results header equals the `SELECT` list, `Sforce-Query-Locator`
pages are concatenated, then insert + idempotency.
`apps/salesforce-mock/src/rest.test.ts` — the mock's own query-job contract
test (create with the SOQL in the body, no batch upload, header-only CSV for
zero rows, locator paging, 404 on the retired ingest shape).
`apps/worker/test/cdc.test.ts` — real gRPC stream, real Avro decode, apply,
`latency_ms`, stale guard, and checkpoint replay after a stop/restart.
`apps/worker/test/cdc-run.test.ts` — the `cdc` sync run lifecycle (closed with
counters + `details.latency_ms` on stop, closed as `disconnected` past the idle
window and reopened on reconnect) and `redriveFailedEvents`
(`still_failing` while the payload is broken, `applied` after it is repaired,
with `error` cleared). Both files clean up their own rows
(`salesforce_id LIKE '006VITEST%'`, their `cdc_events`, `cdc_checkpoints` and
`sync_runs`).
