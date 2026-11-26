# AUDIT — adversarial review of the Salesforce-migration POC

> ## Status header — added after the fixes, not part of the audit
>
> This document is **point-in-time**: the findings below are the audit as written against the build
> it reviewed (`cfb9920`, 2026-11-26). Nothing in the audit itself has been edited — read it as the
> record of what was wrong then.
>
> As committed at `33559d4`:
>
> - **3 of 3 P0 fixed** — P0-1 bulk wire contract (`ebb09fb`), P0-2 a failed CDC apply no longer
>   advances the checkpoint (`2ffb827`, with the operator escape hatches `POST /run/redrive` and
>   `POST /run/discard` in `f327fd4`, and the block derived from the database in `33559d4`), P0-3 lead
>   rate limiting (`3398bcc`).
> - **6 of 8 P1 fixed** — P1-1 and P1-4 (`47471ea`), P1-3 (`2ffb827`), P1-5 (`3398bcc`), P1-7
>   (`f40dc46`), P1-8 (`47471ea`).
> - **2 of 8 P1 partial** — P1-2 (the delete guard exists in `@poc/core`, but the CDC consumer and
>   the redrive helper still call it without the event timestamp) and P1-6 (lockfile and
>   `web`/`mcp`/`mock` healthchecks landed, `worker` still has none and every service is
>   `restart: "no"`).
> - P2s: P2-1, P2-4 and P2-6 fixed; P2-2 and P2-3 partially (the suite now restores the canonical
>   demo state); P2-5 open.
>
> Current behaviour, the accepted head-of-line-blocking tradeoff behind the P0-2 fix, and every
> residue: [`FINDINGS.md`](FINDINGS.md) §3.

Scope: everything in this repo **except** `apps/web/test/e2e/` (owned by a concurrent
agent). Date: 2026-11-26. I changed no repository code; the only state-mutating
experiments ran inside `BEGIN … ROLLBACK` (plus a handful of lead rows I submitted,
which I left in place).

Method: read every code path behind the five capabilities, ran the suite
(`docker compose run --rm tools pnpm test` → **17 files / 131 tests, all passed**, 7.3 s),
then reproduced each capability myself against the live stack (:3000/:3001/:4000/:50051)
and live Postgres. Everything below is backed by a command I ran or a file:line I read.
Note: the working tree changed under me mid-audit (`apps/worker/src/control.ts`,
an e2e-only port 3002, a mock change that allows pinning `SystemModstamp`); findings
describe **committed HEAD** unless flagged.

---

## 1. Verdict — the five capabilities

| # | Capability | My own evidence | Status |
|---|---|---|---|
| 1 | **Bulk extraction** | `tsx src/index.ts bulk` → `Account 4/4, Contact 6/6, Opportunity 6/6, Lead 3/3, TOTAL read=19 applied=19 errors=0`; re-ran → row counts identical (IDEMPOTENT) | ✅ **works — against the in-repo mock only.** The wire calls are not Bulk API 2.0 (P0-1) |
| 2 | **CDC → Postgres** | `POST /mock/emit` UPDATE `006MOCK00004AAAYD2`: PG row `Negotiation / 2,400,000` → `Closed Won / 2,600,000`; `cdc_events` row `applied`, `latency_ms=1` | ✅ against the mock; latency 1–28 ms over 100+ events |
| 2b | **Recovery after interruption** | `/mock/disconnect` → emit during outage → worker reconnected (`preset=CUSTOM replay=1795645444496157`) and applied it: `Proposal/1,250,000` → `Negotiation/1,337,000` | ✅ for a **clean** disconnect. ❌ for a *failing* event (P0-2) |
| 3 | **Internal CRM** | `/crm`, `/crm/{accounts,contacts,opportunities,leads}` all 200; dashboard renders 6 accounts / 9 contacts / 9 opportunities (4 open · $2,772,000) / 13 leads, by-stage bars, `Salesforce`/`Website` source badges, sync card (102 CDC events, 0 failed, 7 stale-skipped, per-channel checkpoints) | ✅ |
| 4 | **Public lead capture** | `POST /api/leads` → `201`; same email again → `200 {"duplicate":true}` **same id**; bad payload → `400` + 3 field errors; 6th from same client → `429`; honeypot → `201` decoy and **0 rows**; rows persisted `source=landing_page,status=new,consent_at=now()`; visible on the dashboard | ✅ (rate-limit defect P0-3) |
| 5 | **MCP** | `/mcp` without token → `401`; `tools/list` → exactly the 17 contract names; `get_sales_summary` → live numbers ($2,685,000 pipeline, 24 SF records); `update_lead_status` → wrote `contacted`, dashboard then rendered "Contacted" | ✅ — via raw JSON-RPC, **not** a real AI agent (§8) |

**Bottom line:** all five capabilities are genuinely implemented and demonstrable in the
compose environment. Three things the docs assert are not true as written (P0-1, P0-2,
the "never regress" guarantee), and the Salesforce integration has never spoken to
Salesforce.

---

## 2. Findings

**P0 = breaks the POC claim · P1 = would break in production · P2 = cosmetic/hygiene.**

### P0-1 · The bulk extractor speaks the mock's dialect, not Bulk API 2.0
**What.** `createQueryJob()` creates an **ingest** job with `operation:"query"`, PUTs the
SOQL text as a CSV batch, PATCHes `UploadComplete` (`packages/salesforce/src/bulk.ts:93-125`),
then reads `jobs/ingest/{id}/successfulResults` expecting a header starting
`sf__Id,sf__Created` (`bulk.ts:153-158`, asserted at `apps/worker/test/bulk.test.ts:56`).
**Evidence.** Salesforce's published contract: a query job is
`POST /services/data/vXX.X/jobs/query` with `{"operation":"query","query":"SELECT …"}`
(the SOQL is in the *create* body); **query jobs take no batch upload** —
`PUT …/jobs/ingest/{id}/batches` is ingest-only; results come from
`…/jobs/query/{id}/results` and contain only the queried columns, never `sf__Id`.
The mock was written to the same invented shape (`apps/salesforce-mock/src/rest.ts:705-706`
registers `/jobs/query` but only implements the ingest+batch flow), so client and mock
agree with each other and disagree with the product. `bulk.ts:2-13` admits it: "exactly
as the mock implements it".
**Impact.** Capability 1 is proven against a self-written emulator. With
`SF_USE_MOCK=false` this fails on the first call. CONTRACTS §6's label "real paths" is
wrong; checklist "Validate Bulk API 2.0 access" was never done.
**Fix.** `POST jobs/query {operation, query}` → poll `jobs/query/{id}` → read
`jobs/query/{id}/results`; drop the batch upload and the `sf__Id` expectation (~30 lines).

### P0-2 · A failing CDC event advances the checkpoint and is then unrecoverable (silent data loss)
**What.** When apply throws, the event is marked `failed` and the checkpoint advances anyway:
```ts
// packages/salesforce/src/cdc.ts:610-617
this.stats.failed += 1;
await markCdcEventProcessed(eventId, 'failed', { error: … });
// Advance anyway: the event is already recorded as failed (dead letter), …
await this.advanceCheckpoint(runner, replayId, header);
```
Nothing re-applies `failed` rows: `reconcile.ts` compares counts/newest stamps only, and a
*replayed* event is caught by `recordCdcEvent` as `duplicate` and skipped (`cdc.ts:594-598`).
The loss is permanent by construction.
**Evidence.** Code path above + `grep -rn "failed" packages/salesforce apps/worker` shows no
retry/redrive; `cdc_events.status='failed'` is the only artefact.
**Impact.** The CRM silently misses a Salesforce change and still reports healthy (the
dashboard's `failed 0` is simply nothing having failed yet). CONTRACTS §7.3 promises
"`saveCheckpoint` **only after** the event is applied (at-least-once)" — the implementation
is at-*most*-once for failures, and "replay after reconnection" does not cover it.
**Fix.** Don't advance on failure (retry with backoff), or advance only over a contiguous
applied prefix and add a `replayFailedEvents()` job that re-drives `cdc_events.failed`.

### P0-3 · The public rate limiter is one global bucket in the documented deployment
**What.** `clientIpFromHeaders()` returns the literal `"unknown"` when neither
`x-forwarded-for` nor `x-real-ip` exists (`apps/web/lib/leads/rate-limit.ts:71-79`) and
buckets are keyed on it (`rate-limit.ts:45-63`). Nothing in `docker-compose.yml` sets those
headers — there is no proxy.
**Evidence (four *different* visitors, direct curl to :3000):**
```
i=1 201  i=2 201  i=3 201  i=4 201  i=5 429  i=6 429
```
**Impact.** Behind the shipped compose file every visitor shares 5 submissions / 10 min: the
landing page starts rejecting real customers after five, and "5 / 10 min / **IP**"
(CONTRACTS §5) is false. It also caps the demo.
**Fix.** Treat unknown-IP as "cannot rate limit" and fall back to a documented global cap, or
put a proxy that sets `X-Forwarded-For` in front and document the requirement.

### P1-1 · "Never overwrites a newer row" is false for records without a timestamp
**What.** The guard (`packages/core/src/ingest.ts:433-436`):
```sql
WHERE EXCLUDED.salesforce_updated_at IS NULL
   OR EXCLUDED.salesforce_updated_at >= COALESCE(<table>.salesforce_updated_at,'epoch')
```
so a record carrying no `SystemModstamp`/`LastModifiedDate`/`commitTimestamp` is accepted
unconditionally. Reproduced with the exact statement `buildUpsert()` emits (`ROLLBACK`ed):
```
before | Closed Won | 2600000.00 | 2026-11-26 00:20:28.551+00
after  | Prospecting|       1.00 | 2026-11-26 00:20:28.551+00   ← regressed, stamp kept
```
**Impact.** The row regresses *and* keeps the newer `salesforce_updated_at`, so the guard is
now desynchronised from the data and later honest events are judged against a lie. No
in-repo caller produces a timestamp-less record today (bulk selects `SystemModstamp` for all
four objects, `packages/salesforce/src/objects.ts:11-47`; the mock always stamps it and
supplies `commitTimestamp`), so this is **latent, not observed end-to-end** — but it
falsifies the contract's unqualified guarantee and is documented as an exception in
`ingest.ts:14-17`. The first CSV import without the column trips it.
**Fix.** `WHERE EXCLUDED.salesforce_updated_at IS NOT NULL AND …`, returning `ignored` with a reason.

### P1-2 · DELETE has no staleness guard
`deleteSalesforceRecord` is a bare `DELETE … WHERE salesforce_id = $1`
(`packages/core/src/ingest.ts:602-625`) called unguarded from CDC (`cdc.ts:604-606`). A
replayed or out-of-order DELETE removes a row whose `salesforce_updated_at` is newer.
**Fix.** Put the timestamp comparison in the DELETE's `WHERE`, or soft-delete with the guard.

### P1-3 · `running` is always false; no `cdc` sync run is ever recorded
`startSyncRun` is called only from `bulk.ts:193` and `reconcile.ts:118`; the DB has only
`bulk_extract` and `reconcile` rows. Hence `GET /api/crm/sync/status` → `"running":false`
and the dashboard shows a grey **"Idle"** pill while four checkpoints are live and events are
being applied. CONTRACTS §3 lists `'cdc'` as a run kind and §7.5 promises CDC latency in
`sync_runs.details` — neither exists (`latency_ms` lives only on `cdc_events`).
**Fix.** One `cdc` run per consumer lifetime/reconnect, closed on stop, with `details.latency`.

### P1-4 · Orphan re-linking never runs on the CDC path
`linkOrphanRecords()` is called only at the end of `applySalesforceBatch`
(`ingest.ts:593`); `grep -rn linkOrphanRecords` shows no CDC caller. A Contact/Opportunity
created by CDC before its Account event (topics are independent, no cross-topic order) stays
`account_id = NULL` until the next bulk extract. **Fix.** call it after an Account upsert.

### P1-5 · Lead duplicate check is TOCTOU (no unique constraint)
`findDuplicate()` then `createLead()` (`apps/web/app/api/leads/route.ts:164-188`) with no
unique index on email (`db/migrations/001_init.sql`): two concurrent submissions of the same
email both insert. **Fix.** partial unique index on `(lower(email)) WHERE source='landing_page'`
+ `ON CONFLICT`, or an advisory lock on `hashtext(email)`.

### P1-6 · No lockfile, and one shared `node_modules` volume set for every service
`pnpm-lock.yaml` is **absent**; `Dockerfile:20` builds with `pnpm install --no-frozen-lockfile`,
so a fresh build resolves today's newest versions. All services mount the same named volumes
and run `tsx watch` / `next dev`, so any `pnpm install` in *any* container relinks `.pnpm`
under running processes. I hit this live:
```
worker-1         | Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express' … /app/apps/worker/src/control.ts
salesforce-mock-1 | Error: Cannot find module '.pnpm/tsx@4.23.15/…/tsx/dist/preflight.cjs'
worker-1         | [tsx] unlink in ../../node_modules/.pnpm/@grpc+grpc-js@1.14.7/… Rerunning…
```
…while `docker compose ps` still showed both as **Up** (only Postgres has a healthcheck).
A concurrent agent was mid-edit; the *fragility* is the finding.
**Fix.** commit the lockfile, `--frozen-lockfile`, separate volumes for `tools`, and add
healthchecks to `web`/`mcp`/`worker`/`mock` so `ps` cannot report a corpse as healthy.

### P1-7 · Mock admin endpoints are unauthenticated on published ports
`/mock/seed`, `/mock/reset`, `/mock/emit`, `/mock/disconnect` have no auth
(`apps/salesforce-mock/src/rest.ts:503-604`) and are published on `0.0.0.0:4000`. CONTRACTS §6
calls this test/demo-only, but on a shared host it is an unauthenticated way to wipe the
dataset or inject arbitrary "Salesforce" changes into the pipeline.
**Fix.** bind to `127.0.0.1:4000`, or require the token on `/mock/*`.

### P1-8 · Silent field drops in the Salesforce mapper
`mapStage` returns `null` for any stage outside the six-value enum and the column is then
omitted (`ingest.ts:196-201`, `239-244`); `amount >= 1e12` and non-finite amounts are dropped
the same way. A new org picklist value (`"Closed Won – Renewal"`) migrates as *no stage*, with
no error and no `errors[]` entry. **Fix.** record an error / fail the record on unmapped non-null enums.

### P2-1 · `README.md` says the opposite of reality
"**Nothing implemented yet** — the repository is scaffolded…", "Planned layout … (Drizzle/Prisma)",
"Detailed setup instructions will land here…" (`README.md:70-100`). The system is complete and
running. No setup instructions, no findings/limitations doc, no cutover notes (checklist §10 #12–14).

### P2-2 · Mock dataset counts polluted by leftover test rows
`GET /mock/health` reported `opportunities: 58` (seed = 6) because CDC tests soft-delete their
`006VITEST…` rows and the mock keeps `IsDeleted` rows. Harmless to bulk (excluded from SOQL and
filtered by `bulk.test.ts`) but the number is misleading.

### P2-3 · `pnpm test` is not hermetic — it writes to the live demo database
The suite runs against the running Postgres and mock; the live worker ingested test events
(`worker-1 | [cdc] Opportunity CREATE 006VITESTF24321AAA … applied`), and
`bulk.test.ts:44` `DELETE`s every `001MOCK%`/`003MOCK%`/… row before re-extracting, so a test
run rewrites demo state (and leaves it rewritten if it fails mid-way). "Test then demo" is unsafe.

### P2-4 · `limit > 200` is a 400, not a clamp
`?limit=100000` → `400 validation_error`. Contract-consistent (`limitSchema.max(200)`) but an
agent asking for 500 gets an error where `normalizeLimit` already knows how to clamp.

### P2-5 · MCP `/health` probes the CRM upstream without auth
`apps/mcp/src/index.ts:25-28` calls `crm.ping()` on an unauthenticated route, exposing CRM
reachability/latency to anyone who can reach :3001. One line to make it static.

### P2-6 · Route tests cover 6 of 21 handlers
`apps/web/test/api/routes.test.ts` exercises only `/accounts*` and `/leads*`; contacts,
opportunities, all three reports and all three sync routes have no direct test (I curl-tested
several; nothing guards them in CI).

---

## 3. Contract conformance (CONTRACTS §3–§8)

| Promise | Reality |
|---|---|
| §3 `@poc/core` API: 4 entity modules + ingest + sync with the exact signatures | ✅ every promised symbol exported from `packages/core/src/index.ts` |
| §3 replay ids `bigint` in PG, **string** in JSON | ✅ `toReplayId`, `$1::bigint`, API returns `"1795…"` |
| §3 `applySalesforceRecord` "never overwrites a newer row" | ❌ **P1-1** |
| §3 `applySalesforceBatch` one transaction per record, per-outcome counts | ✅ |
| §4 **21** method+path combinations, bearer auth, `dynamic='force-dynamic'` | ✅ 21/21 handlers in 15 route files; `requireCrmToken` in **all 15**; `dynamic` in all 15 |
| §4 envelopes `{data,meta}` / `{data}` / `{error:{code,message,details?}}` | ✅ verified by curl + `respond.test.ts` |
| §4 `limit` default 50 / max 200, invalid → 400, unknown row → 404 | ✅ (400 on `limit=100000` and `limit=abc`; see P2-4) |
| §5 lead API: 201 / 200+`duplicate:true` / 400 field errors / 429 / honeypot / no other public CRM route | ✅ all reproduced; `GET /api/leads` → 405 |
| §5 duplicate = same email **and** `source='landing_page'` **and** <24 h | ✅ |
| §5 "5 submissions / 10 min / IP" | ⚠️ per-process *and* per-`unknown` — **P0-3** |
| §6 mock surface, Avro CDC, 1000-event ring buffer, 8-byte BE replay id | ✅ exercised; proto is byte-identical to `forcedotcom/pub-sub-api` except an added 10-line header (`diff` clean) |
| §6 "real paths" for Bulk query jobs | ❌ **P0-1** |
| §7 bulk order Account→Contact→Opportunity→Lead; run twice = no duplicates | ✅ 19 rows both runs |
| §7 CDC `… → markCdcEventProcessed → saveCheckpoint` **after** apply | ⚠️ true on success/duplicate, **false on failure** — **P0-2** |
| §7 backoff 1s→30s + jitter, resume from checkpoint | ✅ observed live (`reconnecting in 1000ms (attempt 1)`) |
| §7 latency in `sync_runs.details` | ❌ **P1-3** |
| §7 explicit `changedFields`/`nulledFields` handling | ⚠️ implicit (only present fields written); works for the mock |
| §8 Streamable HTTP on :3001, `/health`, 17 exact tool names, auth before any CRM call | ✅ (middleware mounted before routes, `index.ts:31-36`; `tools/list` matches exactly) |
| §8 no SQL in MCP, zod inputs, `structuredContent`, annotations | ✅ (`crm-client.ts` only; `readOnlyHint` asserted) |
| §9 UI reads core (never the API), source badge on every list, 12 required routes | ✅ no `fetch` under `app/crm`/`components`; all routes render |
| §0 "never install on the host" | ✅ everything ran in Docker |

---

## 4. Checklist coverage (`docs/POC-CHECKLIST.md`)

Strict: "done" only where I saw evidence myself.

| Section / item | Status |
|---|---|
| §1 Tech stack (Next App Router, Tailwind v4, TS, Node, PG16, Bulk+Pub/Sub, MCP SDK, Compose, Vitest) | done (Bulk is mock-shaped — P0-1) |
| §2 Architecture, shared business logic, isolated SF integration | done |
| §3 Dev Edition / real OAuth / explore real objects / enable CDC / validate Bulk access / document org limits | **not done** — no real org; OAuth code exists, unexercised; the "limits" doc covers public quotas, not our org |
| §3 Extract Accounts / Contacts+Opps / import / preserve SF ids / relationships / idempotent upsert / validate counts | done on the mock; relationships only via bulk order (P1-4) |
| §3 CDC connect / subscribe Account+Opportunity (4 topics implemented) / CREATE·UPDATE·DELETE·UNDELETE | done (UNDELETE = upsert, untested) |
| §3 Persist checkpoints / reconnect+replay / duplicate events | done (verified live) |
| §3 Investigate event ordering | **partial** — per-topic serialisation is real (`runner.queue`), but at HEAD the mock re-stamps `SystemModstamp = now`, so out-of-order delivery is unreachable end-to-end |
| §3 Measure latency | done (`latency_ms` 1–28 ms) |
| §3 Capture changes during initial extraction | **not done** — no snapshot/CDC overlap test |
| §3 Prevent older snapshots overwriting newer | **partial** — holds with timestamps, fails without (P1-1) |
| §3 Test concurrent changes | done (`ingest.test.ts:403`, real `Promise.all`) |
| §3 Basic reconciliation | done (`reconcile` run: 4 objects, `missing=0`, `ok=true`) |
| §3 Document recovery limitations and cutover strategy | **not done** — and P0-2 is precisely the limitation to document |
| §4 Dashboard: 4 counters / recent leads / by stage / sync status | done (sync card says "Idle" — P1-3) |
| §4 Accounts: list / view / **create and update** / search | **partial** — create/list/view/search yes; no update UI (`actions.ts` has no `updateAccountAction`) |
| §4 Contacts: list / view / associate with accounts | **partial** — read-only UI; association only via `POST /api/crm/contacts` |
| §4 Opportunities: list / create and update / stage-amount-date / filter by stage | done (`updateOpportunityAction`) |
| §4 Leads: list / view / search / filter / status update / source / created date | done (status updated via UI action *and* MCP, both reflected) |
| §5 Public page: responsive, title, description, form, success, validation errors, 6 fields, consent | done (all 6 inputs + honeypot present in rendered HTML) |
| §5 `POST /api/leads` validate+sanitize, store, uuid, source, status, timestamp, duplicate by email, rate limit, no public admin endpoints | done except rate limiting (P0-3) |
| §5 Leads in CRM, on dashboard, detail, status update, source shown | done |
| §6 MCP server, Streamable HTTP, connects to internal API, structured IO, param validation, access control | done |
| §6 "Test using an MCP-compatible AI client" + the six demo prompts | **not done** — no AI client configured; raw JSON-RPC only |
| §6 All 17 tools | done |
| §7 Accelerators research (9 items) | done in `docs/AI-ACCELERATORS.md`; citations spot-checked (§6) |
| §8 Migration tests: import / mappings / counts / idempotency / consistency | done |
| §8 CDC tests: CREATE / UPDATE / DELETE / interruption / replay / latency | done (interruption+replay verified live) |
| §8 Lead tests: submit / persistence / CRM / validation / duplicate / status / MCP query | done |
| §8 MCP tests: **real AI client** / discover / query / update / verify in CRM / reject unauthorized | all done except the real AI client |
| §9 Demo 1, Demo 3, Demo 4, Demo 5 | reproducible as-is |
| §9 Demo 2 "modify an Opportunity **in Salesforce**" | **partial** — the mock has no record-update endpoint; the only route is `POST /mock/emit`, a synthetic CDC injection. Defensible for a mock, but it is not "change a record in Salesforce" |
| §10 Deliverables 1–11 | done except README (P2-1) |
| §10 Deliverables 12–14 (setup, findings+limitations, production recommendations) | **not done / partial** — README is a stale stub; limitations/cutover is the largest documentation gap |
| §11 rule 8 "Use **real** Salesforce APIs for migration and CDC" | **not satisfied** — mock only, and the bulk path is not the real API shape |
| §11 rule 11 "Do not invent successful tests or integration results" | upheld — I found no fabricated output in docs or tests |
| Definition of success 1–5 | 1–2 in-mock; 3 only for clean disconnects; 4–5 fully |

---

## 5. Test quality

* **Real, not tautological.** `routes.test.ts` imports the actual handlers and hits the real
  Postgres; `cdc.test.ts` runs a real gRPC stream + Avro decode; `bulk.test.ts` drives real CSV
  over HTTP; `ingest.test.ts:403` fires two concurrent upserts with `Promise.all` and asserts
  the newer one wins.
* **Honest comments.** The stale-write test *states* that it fakes staleness by seeding a future
  timestamp ("the mock stamps SystemModstamp with the emit time", `cdc.test.ts:88-92`) instead of
  pretending to test out-of-order delivery. `bulk.test.ts:70-77` compares against the mock's
  *current* values, not hard-coded ones. Both CDC and route tests explain how they survive the
  parallel demo worker.
* **Self-referential but harmless.** `mcp.test.ts` hard-codes the same 17 names the server
  registers — it can only catch a *changed* name, not a wrong one.
* **Gaps.** 15 of 21 handlers untested (P2-6); nothing asserts behaviour for a timestamp-less
  record (P1-1); unmapped stage/amount untested (P1-8); the rate limiter is tested with synthetic
  `x-forwarded-for`, so the `unknown` fallback (P0-3) is invisible to the suite; nothing checks
  that the suite leaves the demo data intact.

---

## 6. Honesty of the docs

* `docs/AI-ACCELERATORS.md` — the most exposed claims **check out**. Of 18 cited URLs, 8 returned
  `200` (GitHub `sf-skills`, the `@salesforce/mcp` EOL issue, the vendored proto, AppFlow
  pricing/quotas, HubSpot Smart Transfer, arXiv 2412.08194, Valentine, dbt tests, OpenAI docs);
  10 returned `403` from `developer.salesforce.com`, which is bot protection rather than absence
  (retried with browser headers — still 403). Independently confirmed by search: hosted MCP
  servers **GA 2026-04-29**; `@salesforce/mcp` **EOL 2026-11-02**, replaced by
  `forcedotcom/sf-skills`; Pub/Sub **72 h retention** and `num_requested` cap **100**;
  Event Relay **GA + Hyperforce**. **One load-bearing claim I could not confirm:** AppFlow's
  "fixed 10 MB event buffer … events might be dropped" — no source found, and it is the stated
  reason for rejecting AppFlow. The doc does self-label two other items as unverified, which is
  the right instinct.
* `docs/CONTRACTS.md` — accurate as a build spec, except §6's "real paths" label (P0-1) and §7's
  at-least-once claim (P0-2).
* `README.md` — misleading in the *pessimistic* direction: it says nothing is implemented.

---

## 7. Docker reality

* `docker compose config` → valid (exit 0). `init: true` on every node service; Postgres has a
  healthcheck (`pg_isready`, 3 s × 20); `tools` sits behind a profile and works via
  `docker compose run --rm tools`.
* Fresh `up -d` **reasoned, not executed** (per instructions): image build runs
  `pnpm install --no-frozen-lockfile` → `/app/node_modules` exists in the image → the named
  volumes (`nm_*`, `next_cache`) are seeded from image content on first creation → `tsx watch`
  and `next dev` start off the bind mount. `db/postgres-init.sh` applies `001_init.sql` to
  `poc_crm` **and** creates+migrates `poc_crm_test`, so the test DB exists on a virgin host;
  `pnpm migrate` re-runs later.
* **No host install is required** — everything I ran went through `docker compose run/exec`.
* Fragilities: no lockfile and shared `node_modules` volumes (P1-6); only Postgres has a
  healthcheck, so a dead `web`/`mcp`/`worker`/`mock` still shows **Up** (observed);
  `restart: "no"` makes crashes permanent; `mcp` waits on `web: service_started` (not healthy),
  so a tool call can race Next's cold compile.

---

## 8. Claims I could not verify, and why

1. **Any real Salesforce behaviour.** No Dev Edition, no credentials; everything
   Salesforce-shaped was exercised against `apps/salesforce-mock`. That is the largest
   unverified area, and the reason P0-1 matters: the mock's fidelity is assumed — and for Bulk
   it is demonstrably not faithful.
2. **Out-of-order CDC delivery.** At committed HEAD the mock overwrites `SystemModstamp` with the
   emit time (`store.ts:363-364`) and issues monotonic replay ids, so the scenario is unreachable
   end-to-end (my emit pinned `2026-11-26T00:30` and the row landed with `00:20:28`, proving it).
   An **uncommitted** change in the working tree now lets a caller pin the stamp — which would
   make the scenario reachable, but it is new, untested code I did not audit.
3. **A real AI client** (Cursor/Codex/Claude) driving the six §6 prompts. I used `curl` JSON-RPC:
   discovery, live reads and a write all worked and the write is visible in the CRM — but
   "connected an AI agent" is not something I observed.
4. **A poison CDC event end-to-end.** I could not manufacture an apply-time throw from outside
   (`/mock/emit` validates its input), so P0-2 rests on the code path plus the absence of any
   redrive, not on an observed lost record.
5. **`pnpm typecheck`** — not run: the tree was being edited concurrently (`index.ts`, new
   `control.ts`, a new `express` dep, compose port 3002), so a result would describe someone
   else's half-finished work. `pnpm test` (which transpiles what it touches) passed.
6. **A fresh `docker compose up` from empty volumes** — reasoned in §7, not executed.
7. **Whether reconcile's `missing=0` is trustworthy** — it compares counts and newest stamps
   only (the module says so). After the mock reset, local rows were *ahead* of the mock and it
   still said `consistent`, so it cannot see field-level drift.

---

## 9. Sign-off

I would **not** sign this off as "demonstrating the five capabilities against Salesforce". I
*would* sign it off as: an architecture proven end-to-end inside a self-written Salesforce
emulator, with an honest test suite and unusually good defensive engineering (parameterised SQL
everywhere, constant-time auth on both surfaces, honeypot, PII-free logs, real concurrency tests,
a byte-identical vendored Pub/Sub proto) — plus three statements in its own documentation that
are false today: the Bulk API dialect (**P0-1**), at-least-once CDC on failure (**P0-2**), and
"per-IP" rate limiting as deployed (**P0-3**).
