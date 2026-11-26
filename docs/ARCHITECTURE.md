# Architecture

How the POC is put together, and why. Written against commit `ac527fc`; every path below exists and
every claim is traceable to code or to a command in this repo. Open defects referenced here are
catalogued in [`FINDINGS.md`](FINDINGS.md) §3.

---

## 1. Components and the two rules

| Layer | Code | Knows about | Must not |
|---|---|---|---|
| Domain | `packages/core` | CRM entities, SQL, ingest rules | Salesforce field names beyond the mapper, HTTP |
| Salesforce integration | `packages/salesforce` | Bulk 2.0, Pub/Sub gRPC, Avro, SOQL | SQL, CRM validation |
| Sync worker | `apps/worker` | Schedules the two pipelines, control plane | Business rules (delegates to `@poc/core`) |
| Web | `apps/web` | React, server actions, HTTP | SQL in components; `fetch` to its own API |
| MCP | `apps/mcp` | JSON-RPC, tool schemas | SQL, any direct database access |
| Emulator | `apps/salesforce-mock` | Salesforce wire contracts | Being trusted for Salesforce fidelity |

Two rules are structural, not stylistic:

1. **One business-logic layer.** The CRM UI calls `@poc/core` directly from server components
   (`apps/web/app/crm/**`, no `fetch` under `app/crm` or `components` — verified by grep), the HTTP
   API wraps the same functions (`apps/web/app/api/crm/**`), and the worker writes through
   `applySalesforceRecord` / `applySalesforceBatch` / `deleteSalesforceRecord`. There is exactly one
   implementation of every rule — notably the stale-write guard.
2. **Salesforce is isolated.** `packages/salesforce` never imports `pg`; `packages/core` never
   imports a Salesforce HTTP client. The worker is the only process that imports both.

Request paths, from the outside in:

```text
browser      → apps/web (server component)      → @poc/core → SQL
AI client    → apps/mcp  POST /mcp              → apps/web /api/crm/** → @poc/core → SQL
visitor      → apps/web  POST /api/leads        → @poc/core → SQL
Salesforce   → apps/worker (bulk or gRPC)       → @poc/core → SQL
```

---

## 2. Data model

`db/migrations/001_init.sql` is authoritative. Postgres 16, `uuid` primary keys, `numeric(14,2)`
money, `timestamptz` everywhere, `set_updated_at()` trigger on the four entity tables.

| Table | Purpose | Notable constraints |
|---|---|---|
| `accounts` | Companies | `salesforce_id text UNIQUE`; `source IN ('salesforce','local')`; `salesforce_updated_at`; `synced_at` |
| `contacts` | People | `account_id → accounts(id) ON DELETE SET NULL`; `salesforce_id UNIQUE` |
| `opportunities` | Deals | `stage` CHECK against the six-value enum; `amount numeric(14,2) NOT NULL DEFAULT 0`; `close_date date` |
| `leads` | Inbound interest | `source IN ('landing_page','salesforce','manual')`; `status IN ('new','contacted','qualified','closed')`; `consent` + `consent_at` |
| `cdc_events` | Append-only CDC log | `event_id text UNIQUE` (`'<channel>:<replayId>'`) is the idempotency key; `status IN ('pending','applied','skipped_stale','ignored','failed')`; `replay_id bigint`; `latency_ms int` |
| `cdc_checkpoints` | Per-topic resume point | `channel text PRIMARY KEY`; `replay_id bigint`; `status IN ('idle','connected','replaying','error')` |
| `sync_runs` | One row per job | `kind IN ('bulk_extract','cdc','reconcile')`; `status IN ('running','success','failed')`; `details jsonb` |
| `sf_orphan_links` | Parent not yet known | `PRIMARY KEY (entity, local_id)`; resolved by `linkOrphanRecords()` |

### `source` vs `salesforce_id` — the distinction the client asked for

Three states, and the UI badges all three (`components/source-badge.tsx`: blue `Salesforce`, green
`Website`, slate `Local`):

| State | `salesforce_id` | `source` | Meaning |
|---|---|---|---|
| Salesforce record | set | `salesforce` | Imported/synced. Salesforce remains authoritative for this row. |
| Captured locally | `NULL` | `landing_page` (leads) / `local` | Never existed in Salesforce. The CRM owns it. |
| Created in the CRM | `NULL` | `local` / `manual` | Never existed in Salesforce. |

The pair is what makes the cutover conceivable: `salesforce_id IS NOT NULL` is exactly the set of
rows whose lifecycle still depends on the old system, so dual-write, shadow-read and eventual
retirement can be scoped by a single predicate. The CHECK constraints make an unknown provenance
value impossible.

### The stale-write guard, and why it is in SQL

An upsert from an older snapshot must not overwrite a newer row — the classic failure when a bulk
extract overlaps CDC. `buildUpsert()` (`packages/core/src/ingest.ts`) emits:

```sql
INSERT INTO opportunities (…, salesforce_id, source, salesforce_updated_at, synced_at)
VALUES (…)
ON CONFLICT (salesforce_id) DO UPDATE SET …
WHERE EXCLUDED.salesforce_updated_at IS NOT NULL
  AND EXCLUDED.salesforce_updated_at >= COALESCE(opportunities.salesforce_updated_at, 'epoch'::timestamptz)
RETURNING id
```

`>=` (not `>`) so an idempotent replay at an equal stamp still writes. A row with no usable
timestamp may only INSERT: on conflict it is rejected as `ignored` / `reason: 'missing timestamp'`,
and neither its data nor its stamp is touched. DELETE uses the same comparison in its `WHERE` when
the caller passes the event timestamp (`deleteSalesforceRecord(object, id, { updatedAt })`). **The
CDC consumer does not pass it** (`cdc.ts:976` calls it with two arguments; so does the redrive helper
at `redrive.ts:99` — open finding P1-2, `FINDINGS.md` §3), so the DELETE path is guarded in
capability but unguarded in practice.

Why in SQL rather than in application code:

- **Atomicity.** A read-then-write in Node is a TOCTOU window across the web process, the worker
  and any future replica. The comparison is evaluated inside the single `ON CONFLICT` statement,
  under Postgres' row lock.
- **One implementation.** Bulk, CDC, redrive and a future backfill all get the rule for free,
  because they all go through the same statement builder.
- **The timestamp is data, not metadata.** It is stored in `salesforce_updated_at` and compared
  against the *stored* value, so the guard survives a process restart with no in-memory state.

Consequence: the guard depends on the incoming record carrying a timestamp. The mapper falls back
`SystemModstamp` → `LastModifiedDate` → CDC `ChangeEventHeader.commitTimestamp`; anything else is
treated as "cannot prove freshness", hence insert-only.

---

## 3. The four flows

### 3.1 Bulk extract (`packages/salesforce/src/bulk.ts`, `apps/worker`)

```text
runBulkExtract()
  startSyncRun('bulk_extract', {source:'bulk_api_2_0', objects})
  for object of [Account, Contact, Opportunity, Lead]:        ← order matters: FKs
      POST /services/data/v62.0/jobs/query   {operation:'query', query: SOQL, contentType:'CSV'}
      GET  /jobs/query/{id}                  poll until state = JobComplete
      GET  /jobs/query/{id}/results          CSV, header = exactly the SELECT list
                                             follow Sforce-Query-Locator until 'null'
      map rows → applySalesforceBatch(object, CREATE, records)
  finishSyncRun(id, {status, records_read, records_written, details:{objects, totals, duration_ms}})
```

Facts worth knowing: a **query** job takes the SOQL in the create body and has **no batch upload**
(`PUT …/jobs/query/{id}/batches` is not part of the contract; the mock answers 404). Results contain
only the queried columns — no `sf__Id`. Object order Account → Contact → Opportunity → Lead lets the
`account_id` FK resolve on first insert; anything still orphaned lands in `sf_orphan_links`.

Measured (`POST :3002/run/bulk`): `read=19 applied=19 errors=0` in 2,505 ms, 613–642 ms per object
(`Account 4, Contact 6, Opportunity 6, Lead 3`). Running it again leaves row counts unchanged.

### 3.2 CDC apply, checkpoint, replay — and the failure path

One `subscribeOnce` loop per topic (`packages/salesforce/src/cdc.ts`), four topics in parallel, each
with its own queue so per-record ordering is preserved within a topic.

```text
startup:  CdcConsumer.reapOrphanSyncRuns()      close stale kind='cdc' running rows as failed
          startSyncRun('cdc', …)                one run per consumer lifetime
          getCheckpoint(topic)
          replay_id known → Subscribe{replayPreset: CUSTOM, replayId, numRequested:100}
          else            → Subscribe{replayPreset: LATEST}
per event:
          decode Avro(payload) → ChangeEventHeader
          eventId = '<channel>:<replayId>'
          blockedAt set and replayId > blockedAt → drop, not recorded (stats.held), wait for replay
          recordCdcEvent(...)            ON CONFLICT (event_id) DO NOTHING
          duplicate + stored row is NOT 'failed' → advance checkpoint, count, done
          DELETE    → deleteSalesforceRecord(object, id)          ← no timestamp (P1-2)
          otherwise → applySalesforceRecord(object, changeType, record)
          apply throws → retry 3× (250 ms / 1 s / 3 s)
          still failing → cdc_events='failed' (payload + error kept)
                          cdc_checkpoints.status='error', replay_id UNCHANGED
                          [cdc][ALERT] · cancel this topic's stream · blockedAt = replayId
          applied  → markCdcEventProcessed(eventId, outcome)
          advanceCheckpoint(topic, replayId)   ← only if replayId > highest saved
stream error: exponential backoff 1s → 30s with jitter, resubscribe from the checkpoint
operator:     POST :3002/run/redrive → redriveFailedEvents(): re-apply failed rows, oldest first
              POST :3002/run/discard {event_ids:[…]} → discardFailedEvents(): 'ignored' + move
                  that channel's checkpoint past them (the record is NOT applied)
reconnect:    re-reads failed rows for the channel → block derived from the DB, not memory
              rows remain → checkpoint stays status='error' (incident stays visible)
              none remain → '[cdc] … unblocked (no failed events remain at …), resuming'
                            + checkpoint back to 'connected'
stop:         closeSyncRun('consumer stopped')   (or 'disconnected' after 30 s with every topic down)
```

Latency is `Date.now() − ChangeEventHeader.commitTimestamp`, stored per event in
`cdc_events.latency_ms` and logged. Observed: `latency=23` steady state, `0–28 ms` across hundreds of
events, `1,006–1,105 ms` for events that had to wait out a disconnect.

**Replay** is what makes capability 3 work: `/mock/disconnect` ends the gRPC stream server-side, the
mock queues events published with no subscriber (`"queued":true`), the worker reconnects with
`preset=CUSTOM` from `cdc_checkpoints.replay_id` and receives everything after that id. Duplicate
delivery is harmless because `event_id` is unique.

**Failure path — bounded retry, then head-of-line blocking (P0-2, fixed in `2ffb827`).** An apply
that throws is retried 3× in-process; transient blips (deadlock, pool timeout, a slow
`linkOrphanRecords`) recover silently. If all three attempts fail the event is dead-lettered **and
the checkpoint is held**: `cdc_events.status='failed'` keeps the payload and the error,
`cdc_checkpoints` moves to `status='error'` while keeping its `replay_id`, `[cdc][ALERT]` is printed,
and that topic's stream is cancelled so the reconnect re-subscribes from the same checkpoint. Events
behind the blocked replay id are dropped *unrecorded* and re-fetched by the replay, so the checkpoint
can never jump over the hole.

That is **deliberate head-of-line blocking**: the other three topics keep flowing, and nothing is
ever skipped or silently lost. The cost is that one unappliable event stalls its topic until an
operator resolves it, and there are exactly two resolutions:

- **redrive it** — fix the data (or the mapper) and `POST :3002/run/redrive`
  (`packages/salesforce/src/redrive.ts`, bearer `CRM_API_TOKEN`, answer
  `{attempted, applied, skipped_stale, ignored, still_failing}`);
- **discard it** — when the payload can never apply, `POST :3002/run/discard {"event_ids":[…]}` marks
  the row `ignored` with an audit reason and moves that channel's checkpoint past it (never
  backwards), answering `{discarded, not_found, checkpoint_advanced}`. The record is **not** applied;
  a later extract or a corrected `UPDATE` repairs it. There is no automatic redrive loop and no bulk
  discard, on purpose: a poison event is a data or code defect, and hiding it in the background is
  exactly the failure the fix removes.

Either way the block is resolved from the **database**, not from the consumer's memory: on the next
subscribe the consumer re-reads the channel's `failed` rows — if any remain, the checkpoint stays
`status='error'` (a plain reconnect therefore cannot make an incident look resolved); if none remain
it logs `[cdc] … unblocked (no failed events remain at replay=…), resuming`, returns the checkpoint
to `connected`, and the redelivered event is a duplicate that is skipped **and advances** the
checkpoint, so the topic drains in order.

What the operator sees while a topic is blocked: the worker log repeats `[cdc][RETRY]` and
`[cdc][ALERT]`; `GET /api/crm/sync/status` reports `failedEvents: 1` and a checkpoint with
`status: 'error'` (the dashboard card renders `error · replay <id>` in its checkpoint list and the
failed counter turns non-zero); the `cdc` run closes as `failed` if it ends while the event is still
dead-lettered, with `details.blocked`/`details.held` naming the count. The sync card's pill reads
**"Run in progress"** (amber) the whole time the consumer owns an open `cdc` run, and falls back to
"Idle" only after the consumer stops or every topic has been disconnected for 30 s.

`reconcile` (`packages/salesforce/src/reconcile.ts`) is the coarse safety net: per object it compares
the Salesforce row count and newest `SystemModstamp` with the local ones and reports
`missingLocally` / `consistent`. It detects *drift in counts or freshness*, not field-level
divergence, and it cannot see a `failed` event at all.

### 3.3 Public lead capture (`apps/web/app/api/leads/route.ts`)

```text
POST /api/leads   (no token — the only public write path)
  1. rate limit       per-IP 5/10min · per-email 2/10min · global 60/10min  → 429 + retry-after
  2. zod validate     full_name 2–120, email ≤254 valid, phone ≤40, message ≤2000, consent === true
                      trim + strip control chars, email lower-cased        → 400 + per-field details
  3. honeypot         company_website non-empty → 201 decoy, nothing stored
  4. findOrCreateLandingLead()  advisory lock on hashtext(lower(email))
                      existing landing_page lead for that email inside 24h → 200 {duplicate:true}
                      else createLead({source:'landing_page', status:'new', consent_at: now()})
  5. 201 {data:{id,status,source,created_at}}   ← public shape only, no PII echo beyond that
```

The atomicity of step 4 is the point: `pg_advisory_xact_lock` serialises concurrent submissions of
the same address, so two identical requests produce one row (there is deliberately no unique index on
email — Salesforce leads and landing-page leads may legitimately share an address). The three limits
are documented at the top of `apps/web/lib/leads/rate-limit.ts`; the per-IP bucket is unavailable
when no trusted proxy sets `X-Forwarded-For`/`X-Real-IP`, so unknown-IP traffic shares the global
bucket and the per-email guard does the real work. Anything that is not the public route is
token-protected: `GET /api/leads` → 405, `/api/crm/**` → 401 without the bearer.

### 3.4 MCP → internal API → core

```text
POST /mcp (Streamable HTTP, stateless)
  auth middleware      constant-time bearer compare vs MCP_AUTH_TOKEN → 401 before any CRM call
  per request          new McpServer + StreamableHTTPServerTransport (sessionIdGenerator: undefined)
  tools/call name      zod-validated input
  handler              crm-client → GET/PATCH/POST ${CRM_API_BASE_URL}/api/crm/** with CRM_API_TOKEN
                       8 s AbortSignal.timeout, CrmApiError → isError:true (never a raw stack)
  response             content[0].text (human summary) + structuredContent (the exact API payload)
```

17 tools, no SQL, no direct database access: `list_accounts`, `get_account`, `search_accounts`,
`create_account`, `update_account`, `list_opportunities`, `get_opportunity`, `create_opportunity`,
`update_opportunity`, `list_leads`, `get_lead`, `search_leads`, `update_lead_status`,
`get_sales_summary`, `get_opportunities_by_stage`, `get_lead_summary`, `get_sync_status`. Reads
carry `readOnlyHint`; nothing is marked destructive.

Statelessness is deliberate: a fresh server per request means horizontal scaling needs no session
affinity, at the cost of a full JSON-RPC envelope per call and no server-initiated stream (`GET /mcp`
→ 405).

---

## 4. Failure modes

| Failure | What actually happens | Recovery |
|---|---|---|
| **Postgres goes down** | `/api/health` → `db:"down"`; API routes 500 via `toErrorResponse`; UI pages error; the worker's CDC apply throws, is retried 3× in-process, then the event is **dead-lettered and its topic blocked** — the checkpoint is *not* advanced, `[cdc][ALERT]` fires, and that topic re-subscribes from the last good checkpoint (`2ffb827`). So no change is lost, but that topic lags until it can apply; `recordCdcEvent`/`markCdcEventProcessed` failures are logged and swallowed | Restart Postgres. Bulk is safe (idempotent upserts). CDC drains by itself once the database accepts the write (the replay re-delivers the blocked event), or `POST :3002/run/redrive` forces it for the `failed` rows |
| **A CDC event cannot be applied (poison)** | An unmapped picklist value or a constraint violation fails all 3 attempts: `cdc_events.status='failed'` (payload + error kept), `cdc_checkpoints.status='error'` with the `replay_id` **unchanged**, `[cdc][ALERT]` in the log, that topic's stream cancelled and re-subscribed from the same checkpoint. The dashboard shows a non-zero `failed` counter and `error · replay <id>` for that channel — and a reconnect alone does **not** clear it, because the block is re-derived from the `failed` rows. The other three topics keep flowing | Fix the data (or the mapper) then `curl -X POST :3002/run/redrive -H 'authorization: Bearer …'` — the row flips to `applied`, the next subscribe logs `unblocked` and the topic drains. When the payload can never apply, `POST :3002/run/discard {"event_ids":[…]}` marks it `ignored` and moves the checkpoint past it, leaving the record unapplied (the next extract or a corrected `UPDATE` repairs it). Both are in `FINDINGS.md` §3 |
| **Mock / Salesforce unreachable** | Bulk fails at the first call → `sync_runs.status='failed'` with the error; the worker logs `bulk extract failed — CDC consumer still starts` and keeps consuming (which then also fails). On `all` boot, a bulk success younger than 10 min skips the extract (`WORKER_FORCE_BULK=1` overrides) | Restart the mock (`docker compose restart salesforce-mock`, re-seeds pristine data). Bulk re-runs; the CDC consumer reconnects with backoff 1s→30s |
| **Worker dies** | Nothing syncs. `restart: "no"` and **no healthcheck on `worker`**, so `docker compose ps` reports `Up` for a dead process and nothing notices. A crashed **bulk** run leaves `sync_runs.status='running'` forever → the dashboard shows "Run in progress" indefinitely. A crashed **`cdc`** run is reaped as `failed` (`close_reason: 'orphaned'`) by the next consumer at startup | `docker compose restart worker`. Stale bulk runs need a manual `UPDATE sync_runs SET status='failed' WHERE status='running' AND kind='bulk_extract'`. A crashed bulk run is retried on boot unless it succeeded <10 min ago |
| **MCP server dies** | AI clients lose the tool surface; the CRM is unaffected (`mcp` depends on `web: service_started`, not healthy). `/health` probes the CRM upstream without auth, so it also leaks CRM reachability | `docker compose restart mcp`. Stateless, so no session to rebuild |
| **CDC stream drops (cleanly)** | Per-topic exponential backoff with jitter, resubscribe from the persisted checkpoint; duplicates suppressed by `event_id`. Proven: `/mock/disconnect` → `reconnecting in ~1000ms (attempt 1)` → `preset=CUSTOM` → applied | Automatic |
| **Web dies** | CRM and public page 404; MCP tool calls fail with an upstream error (`isError:true`); the worker keeps syncing because it does not need `web` | Healthcheck restarts nothing (`restart: "no"`) — `docker compose up -d web` |
| **Slow/blocked Postgres pool** | `@poc/core` uses a single shared `pg` pool; queries have no per-statement timeout. A lock held by the advisory-lock path blocks only same-email lead writes | Restart the process holding the lock |

The general shape: **bulk is safe to repeat, CDC is never silently lost — but a poison event stalls its
topic by design — and nothing is supervised.** Compose is configured for a demo, not for uptime.

---

## 5. Key design decisions, and the alternative that was rejected

| Decision | Why | Rejected alternative |
|---|---|---|
| **One business-logic layer (`@poc/core`), consumed by UI, API and worker** | Rules like the stale-write guard and lead dedupe exist once; no drift between "the UI path" and "the sync path"; tests hit the same functions production hits | A service layer per surface, or an ORM model duplicated in `apps/web` and `apps/worker`. Rejected: the first divergence would be the timestamp guard, and a second implementation of it would be wrong in a way only production would reveal |
| **UI calls `@poc/core` directly; MCP calls HTTP** | The UI is in the same process, so an HTTP hop would add latency and a second validation layer for nothing. MCP is a different process and must not hold database credentials — HTTP gives it a stable, token-authenticated, auditable contract | (a) MCP with a database connection: fastest to build, but it would put SQL and credentials in the agent-facing process and let an agent bypass every API rule. (b) UI over HTTP: one more failure mode and a second schema to keep in sync |
| **Mock implements the real wire contracts (Bulk 2.0 query jobs, vendored Pub/Sub proto, real Avro schemas)** | The worker's code is then written against the published contract, not against a convenient fiction; swapping in a real org changes configuration, not code shape. The proto is byte-identical to `forcedotcom/pub-sub-api` apart from an added header (the audit diffed the two), and CDC payloads are Avro with the real `ChangeEventHeader` | A REST stub returning JSON ("fake Salesforce"). Rejected: it would have proven nothing about the integration, and the audit's P0-1 is exactly the failure mode — an earlier iteration *did* implement a convenient shape and had to be rewritten |
| **In-memory ring buffer for CDC replay (1000 events) in the mock** | Replay must be demonstrable without external storage, and Salesforce itself only retains 72 h; a ring buffer is a faithful-enough model of a bounded retention window | Durable event storage in the mock (Postgres/Redis). Rejected: it adds infrastructure to the emulator and would hide the real operational question — that consumers must checkpoint, not that the broker remembers |
| **Per-process in-memory rate limiting, three buckets (IP / global / email)** | No extra service in a single-container demo; the per-email bucket is the one that actually protects a lead form, and it works even when every request looks like `unknown` | (a) A single global bucket: what the previous version effectively did, and it rejected the sixth real customer of the day. (b) Redis/edge limiter: correct, but adds a dependency the POC does not need — and is exactly what `FINDINGS.md` §4 requires before production |

Other decisions worth recording:

- **Replay ids as `bigint` in Postgres, `string` in JSON.** A 64-bit id exceeds `Number.MAX_SAFE_INTEGER`;
  serialising it as a JS number would silently corrupt it. `cdc_checkpoints.replay_id` is `bigint`,
  every API/MCP payload carries the string.
- **Server actions for mutations, not client `fetch`.** One revalidation path, no client-side API
  client, no CORS surface on the UI.
- **Orphan parking table instead of failing the record.** Topics are independent, so a Contact event
  can arrive before its Account. Failing it would lose data; waiting would block the stream. Park and
  re-link (after every batch *and* after every applied Account upsert).
- **Fail closed on auth.** Empty `CRM_API_TOKEN` or `MCP_AUTH_TOKEN` rejects every request rather
  than allowing them, and comparison is constant-time on fixed-length buffers.
