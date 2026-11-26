# Findings, limitations and cutover strategy

Checklist §3 "Document recovery limitations and cutover strategy" and §10 deliverables 12–14.
Written against commit `9175ff3`. Every number here was produced by a command in this repo; where
something could not be verified it says so. Where the working tree differs from that commit (a CDC
retry/redrive rework was in flight while this was written), the difference is called out explicitly
and the *committed* behaviour is what is described.

Companion documents: [`AUDIT.md`](AUDIT.md) (the adversarial audit, 17 findings),
[`ARCHITECTURE.md`](ARCHITECTURE.md) (how it works), [`DEMO.md`](DEMO.md) (the runbook).

---

## 1. What the POC proved

| Claim | Evidence |
|---|---|
| A Bulk API 2.0 **query job** can be driven end to end: create job with SOQL in the body, poll to `JobComplete`, read a CSV whose header is exactly the SELECT list, follow `Sforce-Query-Locator` across pages | `POST :3002/run/bulk` → `read=19 applied=19 skipped_stale=0 ignored=0 errors=0` in 2,505 ms (Account 4 / Contact 6 / Opportunity 6 / Lead 3, 613–642 ms per object). `apps/worker/test/bulk.test.ts` has a dedicated `concatenates every Sforce-Query-Locator page` test (page size pinned to 1 via `/mock/config`) |
| Extract is **idempotent**: a second run changes no row | Same endpoint run twice; `apps/web/test/e2e/01-bulk.test.ts` asserts equal counts. Observed live: `applied=19` then `applied=19`, table counts identical |
| Salesforce ids and relationships survive the migration | Rows land with `source='salesforce'`, `salesforce_id` = `001MOCK…`/`006MOCK…`, and `contacts.account_id`/`opportunities.account_id` hold **local uuids** resolved from the Salesforce parent id |
| CDC applies in near real time over a real gRPC stream with real Avro | `POST :4000/mock/emit` UPDATE → Postgres row changed, `cdc_events.status='applied'`, `latency_ms=23`; steady state **0–28 ms** across hundreds of events |
| All four change types work | Observed live, one record, one session: `CREATE applied` → `DELETE applied` (0 rows) → `UNDELETE applied` (row back). `UPDATE` exercised continuously |
| A consumer interruption is recoverable, with no duplicates | `POST /mock/disconnect` → emit answers `"queued":true` → worker logs `reconnecting in 1072ms (attempt 1)` → `subscribed … preset=CUSTOM replay=1795653255416179` → `UPDATE … latency=1105 outcome=applied`. `03-recovery.test.ts` asserts no duplicate `event_id`s and that the checkpoint advanced past both replay ids |
| Older snapshots cannot regress newer rows | Guard in SQL (`ARCHITECTURE.md` §2). `ingest.test.ts` drives two concurrent upserts with `Promise.all`; `02-cdc.test.ts` pins an old `SystemModstamp` and asserts `skipped_stale`. Observed incidentally: after re-seeding the mock with 2024 timestamps, 2 re-imports were correctly rejected as stale |
| A visitor can become a CRM lead with no Salesforce involved | `POST /api/leads` → `201 {source:"landing_page", status:"new"}`; duplicate → `200 {duplicate:true}` (same id); invalid → `400` with 3 field errors; 6th rapid submission → `429`; honeypot → `201` decoy with **0 rows** stored; the lead renders in `/crm/leads` and `/crm` |
| Concurrent duplicate submissions produce one row | `pg_advisory_xact_lock(hashtext(lower(email)))`; `route-limits.test.ts` fires two identical submissions concurrently and asserts one insert (`dedupe.test.ts`, 5 tests) |
| An AI client can drive the CRM entirely through MCP | `tools/list` → exactly 17 contract tools; `get_sales_summary` `structuredContent` equals `GET /api/crm/reports/sales-summary`; `update_lead_status` → `contacted`, verified through the API **and** the server-rendered page; `POST /mcp` without a bearer → `401` before any CRM call |
| The whole thing is reproducible from Docker alone | 26 test files / 212 tests / 23.6 s inside `docker compose run --rm tools`; typecheck of 6 packages clean; no host install at any point |

The engineering that is genuinely production-shaped: parameterised SQL everywhere, constant-time
bearer checks that fail closed, a vendored Pub/Sub proto that is byte-identical to
`forcedotcom/pub-sub-api` apart from an added header (differed by the audit), the stale-write guard
expressed once in SQL, orphan parking instead of record loss, and an E2E suite that asserts against
real HTTP, real gRPC and real rendered HTML rather than against mocks.

---

## 2. What it did **not** prove (all of it requires a real org)

| Area | Why it matters | Status here |
|---|---|---|
| **OAuth against a real org** (External Client App / Connected App, JWT or client-credentials flow, token refresh, instance URL discovery) | The mock issues a static `mock-access-token` and echoes an `instance_url`. A real org will reject the flow if the app, scopes or IP ranges are wrong | Client has a 401-refresh-retry path (`http.ts`), never exercised against a real token endpoint. **Unverified** |
| **Real Bulk API limits and semantics** | Salesforce's concurrent-query-job cap, daily batch limits, 15-minute job expiry, `InvalidJobState`, retry/backoff guidance, `Sforce-Query-Locator` behaviour under load | Only the *shape* of the contract is implemented and tested. Limits are not exercised. **Unverified** |
| **Pub/Sub 72-hour retention and the `num_requested` cap (100)** | If a consumer is down longer than the retention window, replay silently cannot reach the missing events — the loss is permanent at the broker. The 100-event cap controls batch size and therefore throughput | Client sends `numRequested: 100`. The mock retains 1,000 events in memory and never expires them, so **retention loss is not modelled or tested** |
| **Field-level permissions (FLS), record types and picklist values** | The mapper hard-codes six opportunity stages and four lead statuses. A real org has record-type-specific picklist values, dependent picklists and per-profile FLS that can simply omit a field from the SOQL result | Unmapped non-null values now **fail the record loudly** rather than being dropped (fixed, see §3), but which values exist in the client's org is unknown. **Unverified** |
| **Sharing rules / record-level access** | The POC has no user model at all: one bearer token, full read/write. Replacing Salesforce means reproducing who may see which record | Not modelled. Out of scope by design, but it is a *functional* gap, not a cosmetic one |
| **Large-volume behaviour (100k+ records)** | Job polling, CSV pagination, transaction-per-record batch apply, FK resolution and orphan re-linking all have volume-dependent behaviour; `applySalesforceBatch` issues one statement per record | Only 19 records are extracted here. **Unverified** |
| **A real AI client** (Claude Code / Cursor / Codex) executing the §9 prompts | Raw JSON-RPC proves the protocol; it does not prove a model chooses the right tools, handles `isError`, or formats money correctly | **Unverified** — the config blocks are in `DEMO.md` §5, unused by any automated test |
| **Poison-event handling** | Lost CDC changes (P0-2, §3) are the highest-consequence defect and were never observed end-to-end: `/mock/emit` cannot manufacture an apply-time throw | **Unverified by observation**, established from the code path and the absence of any redrive |
| **Does Bulk API still work at all if `SF_USE_MOCK=false`?** | Every call path assumes the mock's auth, dataset and error shapes | Never attempted. Treat "swap the config" as a two-week task, not a switch |

---

## 3. Open defects and limitations after the fixes

Two of the three P0s (P0-1, P0-3) and most P1s from [`AUDIT.md`](AUDIT.md) are fixed and verified in
code (list at the end of this section). **These are the ones still open at `9175ff3`.** Line numbers
are from that commit.

### P0-2 (open as committed) — a failing CDC event advances the checkpoint and is never re-driven

`packages/salesforce/src/cdc.ts:604-618` at `9175ff3`: on an apply throw the event is marked `failed`,
the checkpoint **still advances**, and nothing re-applies `status='failed'` rows — a replay of the
same replay id is caught by the `event_id` dedupe and skipped. The result is a permanently lost
change that the system reports as healthy (`failed: 0` on the dashboard means "nothing failed yet").

Why it matters beyond the data loss: it falsifies the at-least-once promise in `CONTRACTS.md` §7.3,
and any cutover plan that leans on CDC to keep Salesforce and the CRM equal (see §5, phase 2) leans
on exactly this guarantee. **This is the single defect that must be closed before a pilot.**

> **Status of the fix — in flight, uncommitted, not working yet (2026-11-26T00:50Z).** The working
> tree contains a rework: bounded in-process retry (`APPLY_ATTEMPTS`, 250 ms / 1 s / 3 s), then
> dead-letter the event **without advancing the checkpoint**, cancel that topic's stream, leave the
> checkpoint at `status='error'`, print `[cdc][ALERT]`, and hold every later event on that topic
> unrecorded (`stats.held`) until the poison event lands — deliberate head-of-line blocking, chosen
> over silent loss. `packages/salesforce/src/redrive.ts` adds `redriveFailedEvents()` (re-apply
> `failed` rows oldest-first, bypassing the duplicate check, `failed → applied`), exposed as
> `POST /run/redrive` on the worker control plane. The design is sound and the operator surface is
> there, but `apps/worker/test/cdc-run.test.ts` (new, untracked) **failed 3 of 7 tests** when this
> document was written, so **do not describe P0-2 as fixed**. Re-verify before signing anything.

### P1-3 (open as committed) — `sync_runs` never records a `cdc` run, and a crashed run sticks `running: true`

- At `9175ff3`, `startSyncRun` is called only from `bulk.ts:230` and `reconcile.ts:118`. No `cdc` row
  is ever written, so `GET /api/crm/sync/status` and the dashboard sync card cannot show a CDC job —
  the only CDC evidence is `cdc_checkpoints` and `cdc_events`. `CONTRACTS.md` §7.5 also promised CDC
  latency in `sync_runs.details`; at that commit latency lives only on `cdc_events.latency_ms`.
  (The uncommitted rework noted under P0-2 adds one `cdc` sync run per consumer lifetime with
  latency p50/max and `close_reason`.)
- `running` is `SELECT EXISTS (SELECT 1 FROM sync_runs WHERE status = 'running')`
  (`reporting.ts:158`). There is no reaper and `restart: "no"`, so a worker killed mid-bulk leaves
  `running: true` **forever**. Observed live: the API returned `"running":true` with no active job,
  and the dashboard showed "Run in progress".

### P1-6 (partially fixed) — supervision is still demo-grade

Lockfile committed and the image builds with `--frozen-lockfile` (commit `9175ff3`), which removes
the "a rebuild silently resolves today's newest versions" risk. Still open:

- **`worker` has no healthcheck.** `docker compose ps` reports it `Up` while its process is dead.
  `web`, `mcp` and `salesforce-mock` do have healthchecks.
- `restart: "no"` on every node service: a crash is permanent until a human intervenes.
- `mcp` waits on `web: service_started`, not `service_healthy`, so the first tool call can race
  Next's cold compile.

### P1-2 (partially fixed, still open on the CDC path) — an out-of-order DELETE is unguarded

`deleteSalesforceRecord` now accepts `{ updatedAt }` and compares the stamp inside the `DELETE …
WHERE` (`ingest.ts:688-700`), and `applySalesforceRecord`'s DELETE branch does pass the record's
timestamp. **But the CDC consumer does not:** at `9175ff3` it calls
`deleteSalesforceRecord(objectName, sfId)` with two arguments (`cdc.ts:606`), and the working-tree
rework keeps that two-argument call (`cdc.ts:907`, `redrive.ts:96`). So a replayed or out-of-order
`DELETE` still removes a row whose `salesforce_updated_at` is newer. Fix is one argument; the
capability is already there and tested at the core level.

### P2-2 (open) — mock health counts are polluted by test rows

`/mock/health` reported `opportunities: 38` against a 6-record demo dataset after a test run: unit
tests soft-delete `006VITEST…` records and the mock keeps `IsDeleted` rows. Harmless to the
pipeline (SOQL excludes them) but misleading in a demo — quote the seeded counts in
[`DEMO.md`](DEMO.md), not `:4000/mock/health`.

### P2-3 (open) — `pnpm test` is not hermetic; it rewrites the live demo database

The suite runs against the running Postgres and the running mock. `apps/worker/test/bulk.test.ts`
`DELETE`s every `001MOCK%`/`003MOCK%`/… row before re-extracting, and `cdc.test.ts` writes real
`cdc_events` through the live worker. **Never run the full suite directly before a demo** — run the
reset in `DEMO.md` §reset afterwards, or use a dedicated compose project for tests.

### P2-5 (open) — MCP `/health` probes the CRM upstream without auth

`apps/mcp/src/index.ts` calls `crm.ping()` on an unauthenticated route, so anyone who can reach
:3001 can read CRM reachability and latency (`{"status":"ok","tools":17,"upstream":"ok"}`). One
line to make the field static.

### Functional gaps in the CRM UI (not audit findings, but real)

- **Accounts cannot be edited in the UI.** `app/crm/actions.ts` exports `createAccountAction`,
  `createOpportunityAction`, `updateOpportunityAction`, `updateLeadStatusAction` — no
  `updateAccountAction`. `PATCH /api/crm/accounts/[id]` works; there is no screen for it.
- **Contacts are read-only in the UI**, and association with an account is only possible through
  `POST /api/crm/contacts` (or the Salesforce sync). Checklist §4 asks for "associate contacts with
  accounts" — both checklist items are left unticked for this reason.

### Systemic limitations (by design, documented, not bugs)

- **Rate limiting is per-process memory**, three overlapping buckets (per-IP 5/10 min, global
  60/10 min, per-email 2/10 min). Without a trusted proxy the per-IP bucket is unusable, so the
  global + per-email buckets are what protect the form. Windows reset on every `next dev` reload;
  N replicas allow N× the limits.
- **Advisory-lock limits**: `hashtext` is 32-bit, so unrelated emails occasionally serialise for a
  millisecond (harmless); there is no `lock_timeout`, so a pathological holder blocks same-email
  writes until its transaction ends.
- **A failed CDC event blocks its topic** once the in-flight rework lands: that is the right trade
  (no silent loss) but it means one poison record stops *all* changes on its topic indefinitely,
  with no automatic escalation beyond an alert line. Operationally that needs an on-call owner and
  a runbook, which is exactly what `POST /run/redrive` exists for.
- **Reconcile is coarse**: counts and newest `SystemModstamp` only. It reported `consistent` while
  local rows were *ahead* of the mock, and it cannot see field-level drift or `failed` events.
- **`cdc_events.payload` stores the full record as `jsonb`** — convenient, but it is PII at rest
  with no retention policy.
- **No migrations tool.** One idempotent `001_init.sql`, applied by a Postgres init hook and by
  `pnpm migrate`. There is no version table, no down-migration, no review of drift.

### Fixed since the audit (verified in code and in the suite, not by commit message)

| Finding | Fix, verified at |
|---|---|
| P0-1 bulk used an invented ingest-shaped contract | `packages/salesforce/src/bulk.ts` now `POST jobs/query` with SOQL in the body, polls `jobs/query/:id`, reads `jobs/query/:id/results` paging on `Sforce-Query-Locator`; mock answers 404 for `jobs/ingest*` and `PUT …/batches`; `rest.test.ts` grew substantially (~244 changed lines) and a page-size-1 test in `bulk.test.ts` covers the locator |
| P0-3 rate limiter collapsed to one global 5-per-10-min bucket | `apps/web/lib/leads/rate-limit.ts` three-bucket design; private/loopback/CGNAT addresses are treated as unattributable and take the global path; `429` no longer hits the 6th visitor; `rate-limit.test.ts`, `route-limits.test.ts` |
| P1-1 timestamp-less writes could regress rows | Guard is now `EXCLUDED.salesforce_updated_at IS NOT NULL AND … >= COALESCE(…)`; reject path returns `ignored` / `missing timestamp`; `ingest.test.ts` grew by ~243 changed lines with dedicated cases |
| P1-2 DELETE had no staleness guard | `deleteSalesforceRecord(object, id, { updatedAt})` compares the stamp inside the `DELETE … WHERE` (`ingest.ts:688-700`) — **but the CDC path still calls it without a timestamp, see the open list above** |
| P1-4 orphans never re-linked on the CDC path | `linkOrphanRecords()` runs after every applied Account upsert as well as after every batch (`ingest.ts:607`) |
| P1-5 lead dedupe was TOCTOU | `apps/web/lib/leads/dedupe.ts` transaction-scoped advisory lock; concurrent-duplicate test in `route-limits.test.ts` |
| P1-7 mock admin endpoints published on `0.0.0.0` | `docker-compose.yml` publishes `127.0.0.1:4000` and `127.0.0.1:50051` |
| P1-8 unmapped picklist values were dropped silently | `ingest.ts:246` throws `validationError('unmapped StageName: …')`; `applySalesforceBatch` records it in `errors[]` and writes nothing |
| P2-1 README claimed nothing was implemented | `README.md` rewritten |
| P2-4 `limit>200` returned 400 instead of clamping | `limit=100000` → `200` with clamped page; `routes-coverage.test.ts` "limit clamping (P2-4)" |
| P2-6 route tests covered 6 of 21 handlers | `apps/web/test/api/routes-coverage.test.ts` (505 lines, 28 tests) covers contacts, opportunities, reports and sync routes |

---

## 4. What production would require

Ordered by how much damage the current shortcut causes, not by effort.

| # | Requirement | Why the POC's approach fails at scale | Concrete shape |
|---|---|---|---|
| 1 | **Close the CDC loss window** (P0-2) | A dropped change is invisible and permanent; the sync reports healthy | Retry with exponential backoff inside the consumer; advance the checkpoint only over the contiguous applied prefix; a `replayFailedEvents()` job with an attempt counter and alerting on `status='failed' AND attempts > N` |
| 2 | **A real queue / outbox instead of in-process retry** | Retries die with the process; there is no backpressure, no dead-letter surface, no cross-process work distribution; a second worker would double-apply | Postgres outbox + `SELECT … FOR UPDATE SKIP LOCKED` (sufficient here) or SQS/Kafka; one consumer group per topic; idempotency keyed on `event_id` (already unique) |
| 3 | **Idempotency at scale** | Per-record statements are correct but slow; a re-run of bulk re-reads everything | Batched `COPY`/multi-row upsert with the same SQL guard; a run-level watermark (`SystemModstamp` high-water mark) so re-runs read the delta, not the world; bounded concurrency with a per-object limit |
| 4 | **Supervision and deployment** | `restart: "no"`, one missing healthcheck, no replicas, no rolling deploy | `restart: unless-stopped`, healthcheck on `worker` (it has `/health` on :3002 already), readiness gates, a real orchestrator or at least restart policies plus alerting on `sync_runs.status='failed'` and on checkpoint age |
| 5 | **Migrations tooling** | One idempotent SQL file, no version table, no review | A migration runner with ordered, immutable files (node-pg-migrate / Flyway / Atlas), applied in a deploy step, forward-only, with a schema-diff check in CI |
| 6 | **Observability** | `console.log` + a `cdc_events` table; no metrics, no traces, no alerting; `lagSeconds` is computed on read | Structured logs to a collector; metrics for ingest rate, apply latency p50/p95, checkpoint lag per topic, `failed` count, bulk duration and per-record error rate; an alert on `failed > 0` and on lag > threshold; a dashboard per topic |
| 7 | **Secret management** | Tokens live in `docker-compose.yml`; the mock's admin surface is unauthenticated (loopback only) | Secrets from a manager/Vault/KMS, rotated; `CRM_API_TOKEN`/`MCP_AUTH_TOKEN` per client with scopes; mTLS or private networking between MCP and API; no unauthenticated admin endpoints anywhere |
| 8 | **FLS and a permission model** | One token = full access; no user identity, no sharing rules, no field-level restrictions | Map Salesforce profiles/permission sets to an internal RBAC model; enforce field visibility in the API layer (not in the UI); a mapping table per object/field; an explicit decision for every field on whether it may leave the CRM |
| 9 | **Data protection** | `cdc_events.payload` keeps whole records as `jsonb`; no retention, no erasure path | Retention/partitioning on `cdc_events`, encryption at rest, PII classification per column, a deletion path that reaches payload copies, audit log on reads of lead PII |
| 10 | **Rate limiting and abuse controls** | Per-process memory, resets on reload | Shared store (Redis) or the edge limiter; the same three buckets, durable; a persistent submission record keyed on a hashed email |
| 11 | **Backfill and reconciliation you can trust** | `reconcile` compares counts and newest stamps only; it cannot see field drift or lost events | Per-row checksum comparison on demand, a sampled deep-diff job, and a reconciler that reads `cdc_events.status='failed'` |
| 12 | **A real-org adapter, hardened** | `SF_USE_MOCK=false` has never been tried | External Client App with the minimum scopes; Bulk job concurrency and 15-min expiry handling; Pub/Sub `num_requested` and 72-h retention handling (alert if a checkpoint is older than retention); schema fetch via `GetSchema` rather than hard-coded field lists |

---

## 5. Cutover strategy — replacing Salesforce in six months

The premise: Salesforce stays authoritative until each phase's exit criteria are met, and every
phase is reversible. The `source` / `salesforce_id` pair in the schema is what makes each phase
scopable by a single predicate.

Timeline is aggressive but not implausible **for a small object model** (Accounts, Contacts,
Opportunities, Leads + files). It assumes 1–3 engineers and a client-side owner for permissions and
process decisions.

### Phase 0 — Foundations (weeks 1–4)

Exit criteria: production-grade plumbing from §4 rows 1, 2, 4, 5, 6, 7 in place; the CDC loss window
closed; a real org reachable read-only.

- Close P0-2 and the P1-3 supervision gap; add the worker healthcheck and restart policy.
- External Client App in the client's org, read-only scopes, OAuth working from a staging deploy.
- Observability before volume, not after.
- Inventory: every field, record type, picklist, validation rule, workflow/flow, report and
  integration that currently reads or writes Salesforce. This inventory is the real schedule risk,
  and it is a discovery task, not an engineering one.

**Risk**: the drop-to-picklist mapping and FLS are under-estimated. **Mitigation**: the inventory is
a deliverable with a named owner and a sign-off; every field gets a decision (migrate / drop /
compute), and unmapped values fail loudly (already implemented).

### Phase 1 — Bulk load into the CRM, Salesforce still authoritative (weeks 4–8)

Run the extract for the full dataset, repeatedly. Nothing reads the CRM yet.

Safe because: the CRM is a read-only replica from the business's point of view; the extract is
idempotent; the stale-write guard makes repeated loads harmless.

Exit criteria: record counts match per object; a sampled field-level diff of ~100 records per object
is clean; relationship resolution has no orphans (`sf_orphan_links` empty for the Account path);
re-extract changes nothing.

**Risks and mitigations**

| Risk | Mitigation |
|---|---|
| Volume: 100k+ rows, FK order, 15-min job expiry | Extract object-by-object in the fixed order, checkpoint per object, page results; measure on a production-sized copy before signing off |
| Picklists/record types unmapped | Fail loudly (done); produce the unmapped-value report as a Phase 0 artefact and resolve it before the load |
| Deleted/archived records resurrected | Select only what the business wants (`IsDeleted = false`), and decide explicitly about archival |

### Phase 2 — Dual-write shadow: CDC keeps the CRM equal (weeks 8–14)

CDC runs continuously; the CRM is compared to Salesforce daily.

Safe because: nothing yet depends on the CRM; every divergence is a *finding*, not an outage.

Exit criteria: 14 consecutive days with zero unexplained divergence; `cdc_events.failed = 0` **and an
alert if it ever isn't**; checkpoint lag < 1 minute p95; a deliberate poison event is injected and
recovered by the redrive (this is what makes P0-2's fix testable, and it must be proven here).

**Risk**: a silent CDC gap (this is P0-2's exact shape) makes the CRM drift while looking healthy.
**Mitigation**: the daily compare must be independent of CDC — read counts *and* per-row checksums
from both sides; alert on any difference instead of just reporting it.

**Risk**: the 72-hour retention window is exceeded during an outage, and replay cannot reach the lost
events. **Mitigation**: alert when a checkpoint's `last_event_at` exceeds a fraction of retention
(say 24 h); the recovery procedure is a bulk extract, which is already idempotent.

### Phase 3 — Read-path switch, surface by surface (weeks 14–19)

Move one surface at a time from Salesforce to the CRM: first reporting/dashboards, then the
lead-to-opportunity workflow, then account/contact lookups. Salesforce stays writable.

Safe because: reads are the reversible half — each surface can be pointed back in a deploy, and
dual-write keeps the CRM current.

Exit criteria per surface: user sign-off on data correctness; latency equal or better; no report that
disagrees with the previous source beyond explained differences.

**Risks and mitigations**

| Risk | Mitigation |
|---|---|
| Reports/dashboards have no owner until they break | Inventory in Phase 0 lists every report with a user; each is ported or explicitly retired before its surface moves |
| Users keep two tabs open and write in both | Freeze Salesforce writes per surface at switch time (permission-set removal), not at decommission |
| External integrations still read Salesforce | Enumerate them in Phase 0; each gets an owner and either an adapter to the new API or a retirement date |

### Phase 4 — Write-path switch (weeks 19–24)

Writes move to the CRM. Salesforce becomes read-only, then read-only for a subset, then frozen.
Introduce **reverse** sync (CRM → Salesforce) for the frozen window so record history stays complete
for anyone still reading Salesforce.

Safe because: reverse sync means a missed write is still visible in the old system; the freeze is
per object, so a single object can be rolled back without touching the others.

Exit criteria: 7 days of writes in the CRM with reverse sync showing no anomalies; no user-reported
data loss; the write-path rollback drill has been executed once, on purpose, in staging.

**Risk**: the CRM has no permission model equivalent to profiles/sharing (§4 row 8), so the write
switch changes *who can do what*. **Mitigation**: implement RBAC and field visibility before this
phase, not during it; run a permission-matrix comparison as a gate.

### Phase 5 — Decommission (weeks 24–26 and beyond)

Freeze Salesforce entirely. Keep it read-only under a retention contract for the agreed period
(typically a full contract term or the audit/legal minimum), then export and archive. Revoke every
OAuth app, delete integration users, and retire every webhook.

Safe because: the rollback window is deliberately long — the old system is *frozen*, not deleted.

Exit criteria: no API traffic to Salesforce for 30 days; all integrations migrated or retired; final
export verified restorable; data-retention obligations documented and signed.

**Risks and mitigations**

| Risk | Mitigation |
|---|---|
| Attachments/files/notes have no home in the CRM | Decide in Phase 0 whether they migrate; if not, this is a scope change agreed with the client, not a surprise at decommission |
| Audit/history requirements (field history, chatter) | Field history is *not* preserved by this design — `cdc_events.payload` gives a partial change log only while rows exist. Agree the requirement early and add append-only history if it is mandatory |
| Loss of the vendor's disaster recovery | The new system needs its own backup/restore drill, tested before, not after, the switch |
| Nobody remembers the undocumented automation | Phase 0 inventory must include workflow rules, flows, process builder, triggers and scheduled jobs; a second pass with the client's admin is required |

### What makes the whole plan safe, in one sentence

Each phase has a **single reversible pointer** (which source a surface reads, which system accepts
writes), the schema keeps Salesforce-owned rows separable by `salesforce_id IS NOT NULL`, and every
phase gate is a measurement (counts, checksums, lag, failed events) rather than an opinion.

### The honest summary for the client

The architecture is sound and the risky part is not the CRM — it is the **boundary**: picklist and
permission mapping, the long tail of reports and integrations, and the guarantee that no change is
lost between the two systems. The POC demonstrates the first and the third are buildable; it does not
demonstrate they are done, and one defect (P0-2) stands directly between the current state and
Phase 2.
