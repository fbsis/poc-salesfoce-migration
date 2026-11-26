# Architecture

How the POC is put together, and why. Written against commit `9175ff3`; every path below exists and
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
CDC consumer does not pass it** (open finding P1-2, `FINDINGS.md` §3), so the DELETE path is
guarded in capability but unguarded in practice.

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
startup:  getCheckpoint(topic)
          replay_id known → Subscribe{replayPreset: CUSTOM, replayId, numRequested:100}
          else            → Subscribe{replayPreset: LATEST}
per event:
          decode Avro(payload) → ChangeEventHeader
          eventId = '<channel>:<replayId>'
          recordCdcEvent(...)            ON CONFLICT (event_id) DO NOTHING  → duplicate?
          duplicate → advance checkpoint, count, done
          DELETE    → deleteSalesforceRecord(object, id, {updatedAt})
          otherwise → applySalesforceRecord(object, changeType, record)
          markCdcEventProcessed(eventId, outcome)
          advanceCheckpoint(topic, replayId)   ← only if replayId > highest saved
stream error: exponential backoff 1s → 30s with jitter, resubscribe from the checkpoint
```

Latency is `Date.now() − ChangeEventHeader.commitTimestamp`, stored per event in
`cdc_events.latency_ms` and logged. Observed: `latency=23` steady state, `0–28 ms` across hundreds of
events, `1,006–1,105 ms` for events that had to wait out a disconnect.

**Replay** is what makes capability 3 work: `/mock/disconnect` ends the gRPC stream server-side, the
mock queues events published with no subscriber (`"queued":true`), the worker reconnects with
`preset=CUSTOM` from `cdc_checkpoints.replay_id` and receives everything after that id. Duplicate
delivery is harmless because `event_id` is unique.

**Failure path — currently at-most-once (open defect P0-2).** When the apply throws, the consumer
marks the event `failed`, **still advances the checkpoint**, and nothing ever re-applies
`cdc_events.status='failed'`. A replay of the same replay id is caught by the dedupe and skipped. So
a poison event is dropped, silently, while the dashboard reports `failed: 0` (there simply is
nothing in that state). This is the committed behaviour at `9175ff3`.

> **In flight, uncommitted (as of 2026-11-26T00:50Z):** a rewrite of `cdc.ts` (+465 lines) plus
> `packages/salesforce/src/redrive.ts` replaces this with bounded in-process retry (3 attempts,
> 250 ms / 1 s / 3 s), dead-lettering **without** advancing the checkpoint, deliberate head-of-line
> blocking of that topic (`stats.blocked` / `stats.held`), a `[cdc][ALERT]` line, a `cdc` row in
> `sync_runs` with latency p50/max, and an operator redrive `POST /run/redrive` on the worker
> control plane. Its new test file `apps/worker/test/cdc-run.test.ts` **was failing** when this was
> written (3 of 7 tests), so treat it as work in progress, not as delivered behaviour. See
> `FINDINGS.md` §3.

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
| **Postgres goes down** | `/api/health` → `db:"down"`; API routes 500 via `toErrorResponse`; UI pages error; worker's CDC apply throws → event marked `failed` **and the checkpoint advances** (P0-2), so those changes are lost; `recordCdcEvent`/`markCdcEventProcessed` failures are logged and swallowed | Restart Postgres. Bulk is safe (idempotent upserts). CDC is not: re-run a bulk extract to re-anchor, then reconcile — but a deleted record that only a CDC event knew about stays lost |
| **Mock / Salesforce unreachable** | Bulk fails at the first call → `sync_runs.status='failed'` with the error; the worker logs `bulk extract failed — CDC consumer still starts` and keeps consuming (which then also fails). On `all` boot, a bulk success younger than 10 min skips the extract (`WORKER_FORCE_BULK=1` overrides) | Restart the mock (`docker compose restart salesforce-mock`, re-seeds pristine data). Bulk re-runs; the CDC consumer reconnects with backoff 1s→30s |
| **Worker dies** | Nothing syncs. `restart: "no"` and **no healthcheck on `worker`**, so `docker compose ps` reports `Up` for a dead process and nothing notices. `sync_runs.running` can stay `true` forever (observed) → the dashboard shows "Run in progress" indefinitely | `docker compose restart worker`. Stale `running` rows need a manual `UPDATE sync_runs SET status='failed' WHERE status='running'`. A crashed bulk run is retried on boot unless it succeeded <10 min ago |
| **MCP server dies** | AI clients lose the tool surface; the CRM is unaffected (`mcp` depends on `web: service_started`, not healthy). `/health` probes the CRM upstream without auth, so it also leaks CRM reachability | `docker compose restart mcp`. Stateless, so no session to rebuild |
| **CDC stream drops (cleanly)** | Per-topic exponential backoff with jitter, resubscribe from the persisted checkpoint; duplicates suppressed by `event_id`. Proven: `/mock/disconnect` → `reconnecting in ~1000ms (attempt 1)` → `preset=CUSTOM` → applied | Automatic |
| **Web dies** | CRM and public page 404; MCP tool calls fail with an upstream error (`isError:true`); the worker keeps syncing because it does not need `web` | Healthcheck restarts nothing (`restart: "no"`) — `docker compose up -d web` |
| **Slow/blocked Postgres pool** | `@poc/core` uses a single shared `pg` pool; queries have no per-statement timeout. A lock held by the advisory-lock path blocks only same-email lead writes | Restart the process holding the lock |

The general shape: **bulk is safe to repeat, CDC is not safe to lose, and nothing is supervised.**
Compose is configured for a demo, not for uptime.

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
