# CONTRACTS — build rules for parallel agents

This document is the single source of truth for interfaces between parts of the
POC. Several agents build this repo **at the same time, in the same working
tree**. Read every rule; do not deviate without updating this file.

---

## 0. Hard rules (non-negotiable)

1. **Never install anything on the host.** No `npm install`, `pnpm install`,
   `npx <anything>`, no local DB, no local `next`. Everything runs in Docker.
2. **Never `git commit`, `git checkout`, `git reset`, `git stash`.** The lead
   agent commits.
3. **Never run `next build`** (three agents share `apps/web/.next`; concurrent
   builds corrupt it). Use `tsc --noEmit` for type checking and `next dev` is
   already running for runtime checks.
4. **Never restart shared containers** (`postgres`, `web`). `next dev` and
   `tsx watch` hot-reload from the bind mount. You may start/restart the
   service you own (`mcp`, `worker`, `salesforce-mock`).
5. **Stay inside your assigned paths.** See §1. If you believe a file outside
   your paths must change, write the requirement in your final report instead
   of editing it.
6. **Imports inside workspace packages are extensionless** (`from './db'`),
   never `from './db.js'`. Webpack (Next) does not map `.js` → `.ts`.
   `@poc/core` is imported as a bare specifier: `from '@poc/core'`.
7. **All DB access goes through `@poc/core`.** React components never issue SQL.
   The MCP server never issues SQL — it calls the internal HTTP API.
8. **Do not invent results.** If something cannot be verified (real Salesforce
   org, external credentials), say so explicitly in your report and in the
   relevant doc. Never write "tested" for something you did not run.

### Verification commands (all inside Docker)

```bash
# type check everything
docker compose run --rm tools pnpm typecheck
# type check one package
docker compose run --rm tools pnpm --filter @poc/core exec tsc --noEmit
# run the whole test suite
docker compose run --rm tools pnpm test
# run a single test file
docker compose run --rm tools pnpm exec vitest run packages/core/src/leads.test.ts
# psql-style access (no psql client installed, use node + pg from a package)
docker compose run --rm tools pnpm --filter @poc/core exec tsx -e "import {query} from '@poc/core'; console.log(await query('select 1'))"
```

Services already running: `postgres` (:5432), `web` (:3000).

---

## 1. File ownership

| Area | Paths owned | Agent |
|---|---|---|
| Shared foundation | `Dockerfile`, `docker-compose.yml`, `db/`, root configs, `docs/CONTRACTS.md` | lead (do not edit) |
| Core domain layer | `packages/core/**` | core |
| Salesforce client + worker | `packages/salesforce/**`, `apps/worker/**` | salesforce |
| Salesforce mock | `apps/salesforce-mock/**` | mock |
| CRM UI | `apps/web/app/crm/**`, `apps/web/components/**` | crm-ui |
| Public lead page + its API | `apps/web/app/lead/**`, `apps/web/app/api/leads/**`, `apps/web/lib/leads/**` | lead-capture |
| Internal CRM HTTP API | `apps/web/app/api/crm/**`, `apps/web/lib/api/**` | crm-api |
| MCP server | `apps/mcp/**` | mcp |
| Docs (after build) | `docs/*.md` except CONTRACTS.md, `README.md` | docs |

`apps/web/app/layout.tsx`, `app/page.tsx`, `app/api/health/route.ts`,
`app/globals.css` and `postcss.config.mjs` belong to the lead agent. Do not edit.

---

## 2. Data model

Authoritative definition: `db/migrations/001_init.sql`. Read it. Summary:

- `accounts(id uuid, salesforce_id text unique, name, industry, website,
  billing_country, owner_name, source, salesforce_updated_at, synced_at,
  created_at, updated_at)`
- `contacts(id, salesforce_id unique, account_id → accounts, first_name,
  last_name, email, phone, title, source, …)`
- `opportunities(id, salesforce_id unique, account_id → accounts, name,
  stage, amount numeric(14,2), close_date date, owner_name, probability int,
  source, …)`
- `leads(id, salesforce_id unique, full_name, email, phone, company,
  property_interest, message, status, source, consent, consent_at, …)`
- `cdc_checkpoints(channel pk, replay_id bigint, last_event_at, status, error,
  updated_at)`
- `cdc_events(id, event_id unique, channel, object_name, record_id,
  change_type, replay_id, payload jsonb, status, error, latency_ms,
  received_at, processed_at)`
- `sync_runs(id, kind, status, started_at, finished_at, records_read,
  records_written, error, details jsonb)`

Enums (exact strings):

```ts
type OpportunityStage = 'Prospecting' | 'Qualification' | 'Proposal'
                      | 'Negotiation' | 'Closed Won' | 'Closed Lost';
type LeadStatus = 'new' | 'contacted' | 'qualified' | 'closed';
type LeadSource = 'landing_page' | 'salesforce' | 'manual';
type EntitySource = 'salesforce' | 'local';
type ChangeType = 'CREATE' | 'UPDATE' | 'DELETE' | 'UNDELETE';
type CdcEventStatus = 'pending' | 'applied' | 'skipped_stale' | 'ignored' | 'failed';
```

**Source semantics (must be visible in the UI and API):**

- `source = 'salesforce'` → row came from Salesforce (has `salesforce_id`).
- `source = 'landing_page'` → captured by the public page, never in Salesforce.
- `source = 'local'` (or `'manual'` for leads) → created inside the CRM.

---

## 3. `@poc/core` public API (implemented by the core agent)

Everything below is exported from `packages/core/src/index.ts`. Types come from
`packages/core/src/types.ts`.

```ts
// types.ts
export interface Account { id: string; salesforce_id: string | null; name: string;
  industry: string | null; website: string | null; billing_country: string | null;
  owner_name: string | null; source: EntitySource;
  salesforce_updated_at: string | null; synced_at: string | null;
  created_at: string; updated_at: string; }

export interface Contact { id: string; salesforce_id: string | null;
  account_id: string | null; first_name: string | null; last_name: string | null;
  email: string | null; phone: string | null; title: string | null;
  source: EntitySource; salesforce_updated_at: string | null;
  synced_at: string | null; created_at: string; updated_at: string;
  account_name?: string | null; }

export interface Opportunity { id: string; salesforce_id: string | null;
  account_id: string | null; name: string; stage: OpportunityStage;
  amount: string; /* numeric as string */ close_date: string | null;
  owner_name: string | null; probability: number | null; source: EntitySource;
  salesforce_updated_at: string | null; synced_at: string | null;
  created_at: string; updated_at: string; account_name?: string | null; }

export interface Lead { id: string; salesforce_id: string | null;
  full_name: string; email: string; phone: string | null; company: string | null;
  property_interest: string | null; message: string | null; status: LeadStatus;
  source: LeadSource; consent: boolean; consent_at: string | null;
  salesforce_updated_at: string | null; synced_at: string | null;
  created_at: string; updated_at: string; }

export interface Paged<T> { data: T[]; total: number; limit: number; offset: number; }
```

Errors — `packages/core/src/errors.ts`:

```ts
export class AppError extends Error {
  code: 'validation_error' | 'not_found' | 'conflict' | 'unauthorized' | 'internal';
  status: number;            // 400 | 404 | 409 | 401 | 500
  details?: unknown;
}
export function isAppError(e: unknown): e is AppError;
export function toErrorResponse(e: unknown): { error: { code: string; message: string; details?: unknown } };
```

Services (all functions async; each file has its own module):

```ts
// accounts.ts
listAccounts(params?: { search?: string; source?: EntitySource; limit?: number; offset?: number }): Promise<Paged<Account>>
getAccount(idOrSalesforceId: string): Promise<Account>            // throws not_found
createAccount(input: { name: string; industry?: string|null; website?: string|null; billing_country?: string|null; owner_name?: string|null }): Promise<Account>
updateAccount(id: string, input: Partial<{ name: string; industry: string|null; website: string|null; billing_country: string|null; owner_name: string|null }>): Promise<Account>
searchAccounts(term: string, limit?: number): Promise<Account[]>   // name ILIKE, ordered by name

// contacts.ts
listContacts(params?: { search?: string; account_id?: string; limit?: number; offset?: number }): Promise<Paged<Contact>>
getContact(idOrSalesforceId: string): Promise<Contact>
createContact(input: { first_name?: string|null; last_name?: string|null; email?: string|null; phone?: string|null; title?: string|null; account_id?: string|null }): Promise<Contact>
updateContact(id: string, input: Partial<{ first_name: string|null; last_name: string|null; email: string|null; phone: string|null; title: string|null; account_id: string|null }>): Promise<Contact>

// opportunities.ts
listOpportunities(params?: { search?: string; stage?: OpportunityStage; account_id?: string; limit?: number; offset?: number }): Promise<Paged<Opportunity>>
getOpportunity(idOrSalesforceId: string): Promise<Opportunity>
createOpportunity(input: { name: string; account_id?: string|null; stage?: OpportunityStage; amount?: number|string; close_date?: string|null; owner_name?: string|null; probability?: number|null }): Promise<Opportunity>
updateOpportunity(id: string, input: Partial<{ name: string; account_id: string|null; stage: OpportunityStage; amount: number|string; close_date: string|null; owner_name: string|null; probability: number|null }>): Promise<Opportunity>

// leads.ts
listLeads(params?: { search?: string; status?: LeadStatus; source?: LeadSource; created_since?: string; limit?: number; offset?: number }): Promise<Paged<Lead>>
getLead(idOrSalesforceId: string): Promise<Lead>
getLeadByEmail(email: string): Promise<Lead | null>
searchLeads(term: string, limit?: number): Promise<Lead[]>   // full_name/email/company ILIKE
createLead(input: { full_name: string; email: string; phone?: string|null; company?: string|null;
  property_interest?: string|null; message?: string|null; source?: LeadSource;
  status?: LeadStatus; consent?: boolean }): Promise<Lead>
updateLeadStatus(id: string, status: LeadStatus): Promise<Lead>
updateLead(id: string, input: Partial<{ full_name: string; email: string; phone: string|null; company: string|null;
  property_interest: string|null; message: string|null; status: LeadStatus }>): Promise<Lead>

// reporting.ts
getSalesSummary(): Promise<{ accounts: number; contacts: number; opportunities: number; leads: number;
  pipelineValue: number; wonValue: number; openOpportunities: number; newLeads: number;
  salesforceRecords: number; localRecords: number }>
getOpportunitiesByStage(): Promise<Array<{ stage: OpportunityStage; count: number; totalAmount: number }>>
getLeadSummary(params?: { since?: string }): Promise<{ total: number; byStatus: Array<{ status: LeadStatus; count: number }>;
  bySource: Array<{ source: LeadSource; count: number }>; newToday: number; latest: Lead[] }>
getSyncStatus(): Promise<{ running: boolean; lastBulkRun: SyncRun | null; lastCdcEventAt: string | null;
  checkpoints: CdcCheckpoint[]; counts: { cdcEvents: number; failedEvents: number; staleSkipped: number };
  lagSeconds: number | null }>
```

Salesforce ingestion (used by the worker, implemented in core so the
stale-write rule lives in exactly one place):

```ts
// ingest.ts
export interface SalesforceRecord { Id: string; [field: string]: unknown }

export interface ApplyResult {
  outcome: 'applied' | 'skipped_stale' | 'ignored';
  entity: 'account' | 'contact' | 'opportunity' | 'lead' | 'unknown';
  id: string | null;           // local id when applied
  reason?: string;
}

/** Upsert one Salesforce record. Idempotent by salesforce_id.
 *  Never overwrites a newer row, without exceptions: compares the record's
 *  SystemModstamp (falls back to LastModifiedDate, then the CDC
 *  ChangeEventHeader.commitTimestamp) against accounts/contacts/opportunities/
 *  leads.salesforce_updated_at and returns 'skipped_stale' when older. A record
 *  whose timestamp is absent or unparseable may only insert: when a local row
 *  already exists it is rejected as 'ignored' with reason 'missing timestamp'
 *  and neither its data nor its stamp is written (a first insert without a
 *  timestamp is accepted and keeps salesforce_updated_at NULL). */
applySalesforceRecord(objectName: string, changeType: ChangeType, record: SalesforceRecord): Promise<ApplyResult>

/** Bulk upsert, single transaction per record, returns per-outcome counts. */
applySalesforceBatch(objectName: string, changeType: ChangeType, records: SalesforceRecord[]):
  Promise<{ applied: number; skipped_stale: number; ignored: number; errors: Array<{ id: string; message: string }> }>

/** Delete (hard) or mark by salesforce_id. Used for CDC DELETE events. */
deleteSalesforceRecord(objectName: string, salesforceId: string): Promise<ApplyResult>
```

CDC bookkeeping (worker uses this, `sync-status` reports it):

```ts
// sync.ts
startSyncRun(kind: 'bulk_extract' | 'cdc' | 'reconcile', details?: unknown): Promise<string>
finishSyncRun(id: string, patch: { status: 'success' | 'failed'; records_read?: number; records_written?: number; error?: string; details?: unknown }): Promise<void>
getCheckpoint(channel: string): Promise<{ channel: string; replay_id: string | null; last_event_at: string | null } | null>
saveCheckpoint(channel: string, replayId: bigint | number | string | null, patch?: { status?: string; error?: string | null; last_event_at?: string }): Promise<void>
recordCdcEvent(input: { event_id: string; channel: string; object_name: string; record_id: string;
  change_type: ChangeType; replay_id: bigint | string | null; payload: unknown; latency_ms?: number }):
  Promise<{ duplicate: boolean }>
markCdcEventProcessed(event_id: string, status: CdcEventStatus, patch?: { error?: string }): Promise<void>
listCdcEvents(params?: { limit?: number; status?: CdcEventStatus }): Promise<CdcEvent[]>
listSyncRuns(limit?: number): Promise<SyncRun[]>
```

Replay ids are 64-bit. Store as `bigint` in Postgres, but **serialise as string
in JSON** (the API and MCP must never emit a JS number for replay_id).

---

## 4. Internal HTTP API — `apps/web/app/api/crm/**` (crm-api agent)

Auth on **every** route: `Authorization: Bearer ${CRM_API_TOKEN}`.
Missing/incorrect → `401 {"error":{"code":"unauthorized","message":"..."}}`.
Constant-time compare is enough (`crypto.timingSafeEqual` on equal-length
buffers, hashed to a fixed length).

Envelope: list → `{ "data": [...], "meta": { "total": 42, "limit": 50, "offset": 0 } }`;
single → `{ "data": {...} }`; error → `{ "error": { "code": "...", "message": "..." } }`.

| Method | Path | Query / body |
|---|---|---|
| GET | `/api/crm/accounts` | `search, source, limit, offset` |
| GET | `/api/crm/accounts/[id]` | uuid **or** salesforce id |
| POST | `/api/crm/accounts` | `{ name, industry?, website?, billing_country?, owner_name? }` |
| PATCH | `/api/crm/accounts/[id]` | partial |
| GET | `/api/crm/contacts` | `search, account_id, limit, offset` |
| GET | `/api/crm/contacts/[id]` | |
| POST | `/api/crm/contacts` | `{ first_name?, last_name?, email?, phone?, title?, account_id? }` |
| PATCH | `/api/crm/contacts/[id]` | partial |
| GET | `/api/crm/opportunities` | `search, stage, account_id, limit, offset` |
| GET | `/api/crm/opportunities/[id]` | |
| POST | `/api/crm/opportunities` | `{ name, account_id?, stage?, amount?, close_date?, owner_name?, probability? }` |
| PATCH | `/api/crm/opportunities/[id]` | partial |
| GET | `/api/crm/leads` | `search, status, source, created_since, limit, offset` |
| GET | `/api/crm/leads/[id]` | |
| PATCH | `/api/crm/leads/[id]/status` | `{ status }` |
| GET | `/api/crm/reports/sales-summary` | |
| GET | `/api/crm/reports/opportunities-by-stage` | |
| GET | `/api/crm/reports/lead-summary` | `since` |
| GET | `/api/crm/sync/status` | |
| GET | `/api/crm/sync/runs` | `limit` |
| GET | `/api/crm/sync/events` | `limit, status` |

Rules: validate input with zod (`lib/api/schemas.ts`), map `AppError` → status
via `toErrorResponse`, always `dynamic = 'force-dynamic'`, no caching.
`limit` default 50, max 200. Invalid input → 400, unknown row → 404.

The **UI does not call this API** — server components call `@poc/core` directly.

---

## 5. Public lead API — (lead-capture agent)

`POST /api/leads` — no auth, public, rate limited.

Body: `{ full_name, email, phone?, property_interest?, message?, consent }`.
Validation (zod, `apps/web/lib/leads/schema.ts`):
`full_name` 2–120 chars; `email` valid + ≤254; `phone` ≤40 optional;
`property_interest` ≤120 optional; `message` ≤2000 optional; `consent` must be
`true`. Trim + strip control chars. Emails lower-cased before storage/compare.

Behaviour:

- `source = 'landing_page'`, `status = 'new'`, `consent_at = now()`.
- `201 { "data": { "id", "status", "source", "created_at" } }` on success.
- Duplicate: same email already present with `source='landing_page'` and
  `created_at` within 24h → `200 { "data": {...}, "duplicate": true }`
  (no new row). Existing row from other sources is **not** considered a
  duplicate — a new lead is created.
- Validation error → `400 { "error": { "code": "validation_error", "message", "details": { field: message } } }`.
- Rate limit: max 5 submissions / 10 min / IP → `429 { "error": { "code": "rate_limited" } }`.
  In-memory sliding window is fine; document that it is per-process. **Behind a
  proxy, `X-Forwarded-For` (or `X-Real-IP`) must be set; without it the global
  bucket applies** — with no IP header the per-IP limit is unavailable, so
  unknown-IP traffic instead shares a generous per-process bucket
  (60 submissions / 10 min) *and* a per-email guard (a 3rd landing-page
  submission for the same email within 10 min → `429`). All three limits are
  documented in `apps/web/lib/leads/rate-limit.ts`.
- Honeypot field `company_website` filled → pretend success, store nothing.
- Do not expose any other CRM endpoint publicly.

---

## 6. Salesforce mock — `apps/salesforce-mock` (mock agent)

Emulates the subset of Salesforce the worker needs. Two servers in one process.

### REST (port 4000)

OAuth: `POST /services/oauth2/token` (form-encoded `grant_type=client_credentials`)
→ `{ access_token: "mock-access-token", instance_url: "http://salesforce-mock:4000", token_type: "Bearer" }`.
Every other endpoint requires `Authorization: Bearer mock-access-token`, else 401
with a Salesforce-shaped error body.

Bulk query jobs (corrected) — Bulk API 2.0, `:version` = `v62.0`.
A **query** job takes the SOQL in the *create* body; it has **no batch upload**
(`PUT …/jobs/ingest/:id/batches` is ingest-only, and the mock does not implement
ingest jobs at all — those paths answer 404). States: `UploadComplete` (guaranteed
immediately) → `InProgress` → `JobComplete` / `Failed` / `Aborted`.

| Method | Path | Behaviour |
|---|---|---|
| POST | `/services/data/:version/jobs/query` | body `{ operation: 'query', query: 'SELECT … FROM Account', contentType: 'CSV', columnDelimiter: ',', lineEnding: 'LF' }` → `200 { id, operation: 'query', object, createdById, createdDate, systemModstamp, state: 'UploadComplete', jobType: 'V2Query', numberRecordsProcessed: 0, numberRecordsFailed: 0, retries, totalProcessingTime, errorMessage }` |
| GET | `/services/data/:version/jobs/query/:id` | `{ id, state, numberRecordsProcessed, numberRecordsFailed, retries, totalProcessingTime, errorMessage }` — poll until `JobComplete` |
| GET | `/services/data/:version/jobs/query/:id/results` | CSV whose header is **exactly the SELECT list** (`Id,Name,Industry,…`); no `sf__Id` / `sf__Created`. Zero rows still returns the header row. Paged: max `2000` rows per page, the next token is the `Sforce-Query-Locator` response header, echoed back as `?locator=<token>`; the last page sends `Sforce-Query-Locator: null`. An invalid locator is `400 INVALID_PARAMETER`, and a job that is not `JobComplete` is `400 INVALIDJOBSTATE`. |
| PUT | `/services/data/:version/jobs/query/:id/batches` | **404** — a query job takes no data (this used to be the fake SOQL-as-CSV upload) |
| POST | `/services/data/:version/jobs/ingest…` | **404** — ingest jobs are out of scope for this mock |

SOQL: `GET /services/data/:version/query?q=SELECT+Id,Name+FROM+Account` — supports
the shapes the worker sends (`SELECT … FROM <Object> [WHERE SystemModstamp >= X]`,
optional `LIMIT`). Response `{ totalSize, done: true, records: [{ attributes: { type }, … }] }`.
Unlike a query *job*, this endpoint injects `Id` when the caller omits it.

Admin (no auth, test/demo only):

| Method | Path | Behaviour |
|---|---|---|
| POST | `/mock/seed` | `{ accounts?, contacts?, opportunities?, leads?, mode? }` (Salesforce-shaped, `Id` like `001…`) → replaces the dataset by default (`{"mode":"merge"}` adds/overwrites rows instead), returns counts |
| GET | `/mock/state` | current dataset + emitted event log |
| POST | `/mock/reset` | clears dataset + event log |
| POST | `/mock/emit` | `{ object, changeType, record }` → publishes a CDC event to all subscribers of that topic (deferred until a subscriber is attached; queue it) |
| POST | `/mock/disconnect` | `{ topic? }` → forcibly ends matching gRPC streams (simulates consumer interruption) |
| GET | `/mock/health` | `{ status: 'ok', dataset: {...counts}, subscribers: n, queryJobPageSize }` |
| GET/POST | `/mock/config` | `{ queryJobPageSize }` — read/set rows per query-result page (1…2000); the test hook that makes `Sforce-Query-Locator` paging observable |

### gRPC Pub/Sub (port 50051)

Vendor `pubsub_api.proto` (Apache-2.0, from
`forcedotcom/pub-sub-api`) at `apps/salesforce-mock/proto/pubsub_api.proto` and
**copy it to `packages/salesforce/proto/pubsub_api.proto`** the worker will use
the same file — the mock agent owns both copies.

Implement: `Subscribe`, `GetSchema`, `GetTopic`, `GetTopicByName` (unary parts
may return minimal valid responses; `Subscribe` must stream).

- `Subscribe{ topic, replayPreset: LATEST|EARLIEST|CUSTOM, replayId, numRequested }`
  → `stream FetchResponse{ latestReplayId, events[], pendingBatch, rpcId }`.
- Event `payload` is **Avro binary** encoded with the real Salesforce CDC schema
  for `AccountChangeEvent` / `OpportunityChangeEvent` / `ContactChangeEvent` /
  `LeadChangeEvent`: top-level `{ ChangeEventHeader, ...fields }`.
  `ChangeEventHeader` = `{ entityName, recordIds: [], changeType, changedFields: [],
  changeOrigin, transactionKey, sequenceNumber, commitTimestamp, commitNumber,
  commitUser, nulledFields: [], diffFields: [], isTransactionEnd }`.
  Register schemas with `avsc` and serve via `GetSchema`.
- `replayId` is a **byte array of the 8-byte big-endian signed long**.
- Replay: `CUSTOM` + last known replay id → re-send every buffered event with
  `replayId > given`. Keep an in-memory ring buffer of the last 1000 events so
  replay works without external storage.
- `commitTimestamp` must be monotonically increasing per event (ms epoch), and
  `sequenceNumber` increasing per record — the worker uses them for ordering.

Seed dataset must include at least 3 accounts, 5 contacts, 4 opportunities and
2 leads so the migration is demonstrable.

---

## 7. Worker — `apps/worker` + `packages/salesforce` (salesforce agent)

`WORKER_MODE`: `all` (default), `bulk`, `cdc`, `reconcile`. Also a CLI
(`tsx src/index.ts bulk`) used by tests and the demo.

Bulk extract (`packages/salesforce/src/bulk.ts`):
1. `startSyncRun('bulk_extract')`
2. For each object (`Account`, `Contact`, `Opportunity`, `Lead`): create query
   job, upload SOQL-as-CSV, poll until `JobComplete`, download
   `successfulResults` CSV, parse (`csv-parse`).
3. Map to the internal shape and call `applySalesforceBatch` from `@poc/core`
   (order: Account → Contact → Opportunity → Lead so FKs resolve).
4. `finishSyncRun(id, { status, records_read, records_written })`.
5. Idempotent: running twice must not duplicate rows.

CDC consumer (`packages/salesforce/src/cdc.ts`):
1. `getCheckpoint(topic)` → replay id; connect with `CUSTOM` replay when known,
   else `LATEST`.
2. For each event: decode Avro → `recordCdcEvent(...)` (dedupe by
   `<channel>:<replayId>`) → `applySalesforceRecord(...)` or
   `deleteSalesforceRecord(...)` → `markCdcEventProcessed(outcome)`.
3. `saveCheckpoint` **only after** the event is applied (at-least-once).
4. Reconnect with exponential backoff (1s → 30s, jitter), resume from checkpoint.
5. Log latency (`latency_ms` = now − commitTimestamp) and expose it in
   `sync_runs.details`.
6. Handle `update` with `changedFields` and `nulledFields`, `delete`, `undelete`.

Mock vs real: `SF_USE_MOCK=true` (default) uses `SF_LOGIN_URL`/`PUBSUB_ENDPOINT`
from compose; when false, use the real OAuth + `api.pubsub.salesforce.com:7443`
and real Avro schemas from `GetSchema`. Both paths share the same interfaces.

---

## 8. MCP server — `apps/mcp` (mcp agent)

`@modelcontextprotocol/sdk`, **Streamable HTTP** transport on `MCP_PORT` (3001),
endpoint `POST/GET /mcp`. Also `GET /health`.

Auth: `Authorization: Bearer ${MCP_AUTH_TOKEN}`. Reject → 401 without touching
the CRM. Log tool name + args summary + outcome for every call.

Every tool calls the internal HTTP API (`CRM_API_BASE_URL`, `CRM_API_TOKEN`).
No SQL, no direct DB.

Tools (names exactly as in the checklist, snake_case):

| Tool | Args | Returns |
|---|---|---|
| `list_accounts` | `search?, limit?, offset?` | `{ data, meta }` |
| `get_account` | `id` | `{ data }` |
| `search_accounts` | `term, limit?` | `{ data }` |
| `create_account` | `name, industry?, website?, billing_country?, owner_name?` | `{ data }` |
| `update_account` | `id, ...partial` | `{ data }` |
| `list_opportunities` | `stage?, search?, account_id?, limit?, offset?` | `{ data, meta }` |
| `get_opportunity` | `id` | `{ data }` |
| `create_opportunity` | `name, account_id?, stage?, amount?, close_date?, owner_name?` | `{ data }` |
| `update_opportunity` | `id, ...partial` | `{ data }` |
| `list_leads` | `status?, source?, search?, created_since?, limit?, offset?` | `{ data, meta }` |
| `get_lead` | `id` | `{ data }` |
| `search_leads` | `term, limit?` | `{ data }` |
| `update_lead_status` | `id, status` | `{ data }` |
| `get_sales_summary` | — | sales summary |
| `get_opportunities_by_stage` | — | stage breakdown |
| `get_lead_summary` | `since?` | lead summary |
| `get_sync_status` | — | sync status |

Each tool: zod schema for input, `outputSchema` where useful, `structuredContent`
returned, human-readable `content` text with a compact table/summary. Tool
errors → `isError: true` with the API error message (never a raw stack).
Mark every tool with `annotations` (`readOnlyHint` for the reads,
`destructiveHint: false`).

---

## 9. UI conventions (crm-ui, lead-capture)

- Tailwind **v4**: no `tailwind.config.*`. Theme tokens live in
  `apps/web/app/globals.css` under `@theme`. Use the provided
  `brand-*` colors plus Tailwind's slate palette.
- Server Components by default. Client components only for forms, filters with
  `useState`, and anything using event handlers — put `'use client'` at the top.
- Data reads: `await listAccounts()` etc. from `@poc/core` inside server
  components. Never `fetch` the internal API from the UI.
- Mutations: server actions (`'use server'`) calling `@poc/core`, then
  `revalidatePath`. No client-side fetch to `/api/crm`.
- Every list shows a `source` badge: `Salesforce` (blue), `Website` (green),
  `Local` (slate) — this is a required POC distinction.
- Numbers: `Intl.NumberFormat` with `USD` for money, `date-fns`-free ISO
  formatting via `Intl.DateTimeFormat` (avoid new dependencies).
- No new npm dependencies. (Anything you think you need: report it.)
- Accessibility: real `<label for>`, `<button type="submit">`, focus states,
  `aria-live` for form feedback.

Routes required:

- `/crm` dashboard — 4 counters, recent leads, opportunities by stage, sync status card.
- `/crm/accounts`, `/crm/accounts/[id]`, `/crm/accounts/new`
- `/crm/contacts`, `/crm/contacts/[id]`
- `/crm/opportunities` (filter by stage), `/crm/opportunities/new`, `/crm/opportunities/[id]`
- `/crm/leads` (search + status filter), `/crm/leads/[id]` (status update)
- `/lead` public page with the form.

---

## 10. Reporting back

Finish with a short report: files created, commands run **with their real
output**, what works, what is unverified, and any contract deviation. Honesty
over optimism — the lead agent re-verifies everything.
