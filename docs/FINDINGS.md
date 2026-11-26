# Findings, limitations and cutover strategy

Checklist §3 "Document recovery limitations and cutover strategy" and §10 deliverables 12–14.
Updated against commit `33559d4` (`2ffb827` P0-2/P1-3, `f327fd4` operator discard, `33559d4`
block-derived-from-database, `ac527fc` deterministic suite). Every number here was produced by a
command in this repo; where something could not be verified it says so. Line numbers are from
`33559d4` unless a commit is named, and nothing here describes uncommitted work.

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
| The whole thing is reproducible from Docker alone | 28 test files / 218 tests (5 skipped) / ~25 s inside `docker compose run --rm tools` at `ac527fc`, green on two consecutive runs, and the suite restores the canonical demo dataset when it finishes; typecheck of 6 packages clean; no host install at any point |

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
| **Poison-event handling** | Lost CDC changes (P0-2) were the highest-consequence defect; the point of the fix is that a poison event is *visible, blocked, and resolvable* — either by redriving it once the data is fixed, or by explicitly discarding it when it never can be — rather than silently dropped | Proven against the mock, not merely argued: unit tests, E2E, and observed live (an emitted `StageName: "Closed Won – Renewal"` → `[cdc][RETRY]` ×3 → `[cdc][ALERT]` → checkpoint `status='error'` with the replay id unchanged → `POST /run/redrive` once the data was fixed → `applied` → `unblocked`; and the discard path → `ignored` + checkpoint advanced). What is *not* proven is operator practice against a real org: who is paged, how fast a payload is repaired, and who is allowed to discard |
| **Does Bulk API still work at all if `SF_USE_MOCK=false`?** | Every call path assumes the mock's auth, dataset and error shapes | Never attempted. Treat "swap the config" as a two-week task, not a switch |

---

## 3. Open defects and limitations after the fixes

All three P0s and most P1s from [`AUDIT.md`](AUDIT.md) are fixed and verified in code (list at the
end of this section). **These are the ones still open at `33559d4`.** Line numbers are from that
commit.

### The tradeoff P0-2's fix accepts — a poison event blocks its topic (by design, not a bug)

`packages/salesforce/src/cdc.ts:960-1110`: an apply that throws is retried **3× in-process**
(`APPLY_RETRY_DELAYS_MS = [250, 1_000, 3_000]`). If every attempt fails the event is dead-lettered
**and the checkpoint is not advanced**: `cdc_events.status='failed'` keeps the payload *and* the
error, `cdc_checkpoints` is left at `status='error'` (with the message) holding its old `replay_id`,
that topic's stream is cancelled, `[cdc][ALERT]` is printed, and the reconnect re-subscribes from the
last good checkpoint — so the poison event is re-delivered and retried, and events *behind* it are
dropped unrecorded and re-fetched by the replay. Nothing is ever skipped.

What that costs, stated plainly:

- one unappliable event stalls **its own** topic until it applies; the other three topics keep
  flowing. This is deliberate head-of-line blocking, chosen over silent loss: a bounded, visible
  stall beats a permanently missing change that the dashboard still reports as healthy;
- the reconnect backoff grows 1 s → 30 s with jitter, so retries do not hammer, and every retry
  writes the same alert line;
- there is no automatic redrive loop, on purpose: a poison event is a data or code defect, and
  retrying it forever in the background hides it. Resolution is a deliberate operator decision —
  **fix and redrive**, or **discard** when the payload can never apply (below).

**Recovery 1 — redrive (the payload can apply once the data or the mapper is fixed).**
`POST :3002/run/redrive` (bearer `CRM_API_TOKEN`, body optional `{"limit":50}`) re-applies every
`failed` row oldest-first through the same `@poc/core` functions, bypassing the duplicate check, and
answers `{attempted, applied, skipped_stale, ignored, still_failing}` — a non-zero `still_failing` is
a report, not an HTTP error. The row flips `failed → applied|skipped_stale|ignored`, and the block
is resolved from the **database**, not from memory: on that channel's next subscribe the consumer
re-reads the `failed` rows, logs `[cdc] … unblocked (no failed events remain at replay=…), resuming`,
returns the checkpoint to `connected`, and the redelivered event is a duplicate that is skipped
**and advances** the checkpoint. The topic then drains in order. The same read is what stops a bare
reconnect from clearing an incident: while `failed` rows remain, the checkpoint stays
`status='error'` (with `blocked by N failed event(s), oldest replay …`) so the sync card keeps
showing it.

**Recovery 2 — discard (the payload can never apply).**
`POST :3002/run/discard {"event_ids":["<channel>:<replayId>", …]}` marks those `failed` rows
`ignored` with the audit reason `discarded by operator (event abandoned; the record was not applied)`
and moves that channel's checkpoint past them (never backwards), answering
`{discarded, not_found, checkpoint_advanced}`; the tool is
`discardFailedEvents()` in `packages/salesforce/src/redrive.ts:168`. It is explicit, per event id,
logged, and auditable — the row stays in `cdc_events` as `ignored` — but **the record that event
described is not applied**: a later bulk extract or a corrected `UPDATE` from Salesforce is what
repairs it. There is no bulk "drop everything" and no automatic discard, by design: silently
abandoning data is the failure this whole mechanism exists to avoid.

Both were observed live in this repo (not inferred): `[cdc][RETRY] … attempt=1/3 … 3/3` →
`[cdc][ALERT] … checkpoint NOT advanced (blocked)` → `cdc_checkpoints.status='error'` with
`replay_id` unchanged while the other three channels stayed `connected`; then redrive (after repairing
the stored payload) → the row `applied`, `unblocked`, `outcome=duplicate`, checkpoint back to
`connected` and the row updated; and on the other branch, discard → `ignored` +
`checkpoint advanced to <replay id>` with the record left untouched.

### P1-3 (fixed) — the `cdc` run is recorded, and a dead consumer's run is reaped

`cdc.ts:571-700`: one `sync_runs` row of kind `cdc` per consumer lifetime — opened on `start()`,
closed on `stop()` or after **every** topic has been disconnected for `CDC_RUN_IDLE_CLOSE_MS`
(30 s default) with `close_reason: 'disconnected'`, and a new one opened on the next live
subscription. `details` carries `applied / skipped_stale / ignored / failed / duplicates / blocked /
held / events`, `latency_ms {p50, max, samples}`, `duration_ms`, `reconnects` and `close_reason`;
`records_read` = events received, `records_written` = applied; the run closes as `failed` when an
event was dead-lettered during it. `CdcConsumer.reapOrphanSyncRuns()` (`cdc.ts:600-615`) closes stale
`kind='cdc'` `running` rows as `failed` / `close_reason: 'orphaned'`, and
`apps/worker/src/index.ts:147` calls it once at startup — so a container killed before the graceful
close no longer leaves the dashboard saying "Run in progress" forever.

Residue: this fixes the **CDC** half only. A **bulk** run killed mid-flight still leaves
`running: true` indefinitely (`reporting.ts:157-160` has no age filter and every service is
`restart: "no"`), and `worker` still has no healthcheck — P1-6 below.


### P1-6 (partially fixed) — supervision is still demo-grade

Lockfile committed and the image builds with `--frozen-lockfile` (commit `9175ff3`), which removes
the "a rebuild silently resolves today's newest versions" risk. Still open:

- **`worker` has no healthcheck.** `docker compose ps` reports it `Up` while its process is dead.
  `web`, `mcp` and `salesforce-mock` do have healthchecks.
- `restart: "no"` on every node service: a crash is permanent until a human intervenes.
- `mcp` waits on `web: service_started`, not `service_healthy`, so the first tool call can race
  Next's cold compile.

### P1-2 (still open on the CDC and redrive paths) — an out-of-order DELETE is unguarded

`deleteSalesforceRecord(object, id, { updatedAt })` compares the stamp inside the `DELETE … WHERE`
(`ingest.ts:670-700`), and the CDC *upsert* path gets a timestamp through the mapper. **But both
CDC-side delete callers pass two arguments**: `packages/salesforce/src/cdc.ts:976`
(`deleteSalesforceRecord(objectName, sfId)`) and `packages/salesforce/src/redrive.ts:99`. So a
replayed or out-of-order `DELETE` still removes a row whose `salesforce_updated_at` is newer — and
the replay path is exactly where an old delete arrives late. Verified by reading `33559d4`, not from
a commit message: the capability exists and is tested at the core level; the consumer does not use
it. The fix is one argument (`header.commitTimestamp`) threaded through both call sites.

### P2-2 (partially fixed) — mock health counts are inflated *during* a run

`/mock/health` reported `opportunities: 38` against a 6-record demo dataset after a test run: unit
tests soft-delete `006VITEST…` records and the mock keeps `IsDeleted` rows. At `ac527fc` the suite's
global setup resets and re-seeds the mock (replace, not merge) when the run finishes, so the counts
come back to the canonical 4/6/6/3 — but only if the run reached its teardown. During a run, and
after an aborted one, the numbers are still wrong for a demo — quote the seeded counts in
[`DEMO.md`](DEMO.md), not `:4000/mock/health`.

### P2-3 (partially fixed) — `pnpm test` is not hermetic, and it needs an idle stack

The suite still runs against the running Postgres and the running mock (deliberate: it proves real
HTTP, real gRPC, real SQL). At `ac527fc` it is **self-restoring**: `apps/web/test/global-setup.ts`
returns a teardown that resets and re-seeds the mock with the canonical dataset, deletes the
Salesforce-mirror rows, runs one real bulk extract and drops leftover test-shaped rows. A completed
run therefore no longer damages demo state; a run that dies before teardown still can.

What remains: it needs the stack up, and it **owns the stack while it runs**. Anything else using the
same mock and worker at the same time wins, because the shared in-memory mock and the shared database
are the fixture: a second concurrent `pnpm test` (each run's teardown restores the dataset the other
is asserting on, so both fail intermittently), a live demo, or a manual poison-event experiment.
Observed here: concurrent runs failed on shared-state assertions (`expected 14 to be 30` records,
`CDC UPDATE reflected in the CRM API` timing out) with the code unchanged. Treat "the suite is green"
as a statement about an idle stack, and serialise runs rather than debugging the code when the
numbers move.

The earlier flakiness had the same shape but a different cause, and it is worth recording because it
looks like a race and is not: a demo opportunity had been mutated to an unmapped `StageName`, the
strict mapper (P1-8) correctly rejected it, and every bulk-based test failed with `errors=1` — one
bad row in shared state, not a scheduling problem. The fixture now removes that carrier, but only
from the state it owns.

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
- **A failed CDC event blocks its topic** (P0-2's fix, §3): the right trade over silent loss, but it
  means one poison record stops *all* changes on its topic until it is resolved — `POST /run/redrive`
  once the data (or the mapper) is fixed, or `POST /run/discard` when the payload can never apply,
  leaving that record unapplied. There is no automatic escalation beyond the alert line, so
  operationally this needs an on-call owner and a runbook — which is what those two endpoints are.
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
| P0-2 a failing CDC event advanced the checkpoint and was never re-driven | `packages/salesforce/src/cdc.ts:960-1110`: 3 in-process attempts (250 ms / 1 s / 3 s), then dead-letter the event **without** advancing the checkpoint (`blockOnFailure` leaves `cdc_checkpoints.status='error'` and cancels that topic's stream), `[cdc][ALERT]`, and re-subscribe from the same checkpoint. Resolution is operator-driven and auditable: `packages/salesforce/src/redrive.ts` — `redriveFailedEvents()` behind `POST :3002/run/redrive`, and `discardFailedEvents()` behind `POST :3002/run/discard` for a payload that can never apply (`f327fd4`). The block is re-derived from the `failed` rows on every subscribe (`33559d4`), so a reconnect cannot make the incident disappear. Covered by `apps/worker/test/cdc-run.test.ts` and the poison-event drill; observed live (`RETRY` ×3 → `ALERT` → `checkpoint status=error`, replay id unchanged → redrive → `applied`/`unblocked`; and discard → `ignored` + checkpoint advanced) |
| P1-3 no `cdc` row in `sync_runs`, and a crashed run stuck at `running: true` | `cdc.ts:571-700`: one `cdc` run per consumer lifetime, counters + `details.latency_ms` + `close_reason`, closed as `failed` when an event was dead-lettered, idle-closed after 30 s of every topic being down; `CdcConsumer.reapOrphanSyncRuns()` at worker startup (`apps/worker/src/index.ts:147`). `/api/crm/sync/status` therefore answers `running: true` while the consumer is up (the card reads "Run in progress", not "Idle") |
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
| 1 | **Operate the CDC window you closed** (P0-2's residue) | The loss window is closed in-process at `2ffb827`: a poison event blocks its topic, and `redrive`/`discard` (`f327fd4`) resolve it. What is missing is the operational half: no attempt counter on `cdc_events`, no escalation beyond an `[cdc][ALERT]` log line, no metrics/alerts, and no approval trail for `POST /run/discard` — the endpoint is authenticated but anyone holding `CRM_API_TOKEN` can abandon data | Promote the alert to a real alert (`failed > 0`, or a checkpoint in `status='error'` older than N minutes), expose `sync_runs.details.blocked`/`held` as metrics, keep a retry-attempt count per event, and gate discard behind a named approver plus an immutable audit record |
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

- P0-2 is closed in-process (`2ffb827`) and P1-3's CDC half too; still close the **bulk** half of P1-3
  and the P1-6 supervision gap: worker healthcheck, `restart: unless-stopped`, an age filter on
  `sync_runs.status='running'`.
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
recovered by the redrive **in the client's org** (the mechanism exists at `2ffb827` and was drilled
against the mock — this gate is what proves it against real picklist values and real payloads), and
the policy for abandoning an event that can never apply is agreed and written down.

**Risk**: a topic sits blocked behind one poison event and nobody reads the log for a week — the CRM
ages quietly while every other signal looks healthy. Blocking removed the *silent loss*, not the
*silent staleness*. **Mitigation**: alert on `cdc_checkpoints.status='error'` and on checkpoint age
(`last_event_at` older than N minutes), not only on `failed > 0`; the daily compare must be
independent of CDC — read counts *and* per-row checksums from both sides, and alert on any
difference instead of just reporting it.

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
lost between the two systems. The POC now demonstrates all three are buildable: no change is dropped
silently (a poison event blocks its topic and is redriven, §3), and the two remaining obstacles are
supervision/operability and the fact that nothing has ever spoken to a real org.
