# POC — Salesforce Migration, CDC & AI-Ready CRM with MCP

A working proof of concept for replacing Salesforce gradually: **Bulk API 2.0** extraction into
Postgres, near-real-time sync over the **Pub/Sub API (Avro CDC)**, a small Next.js CRM that owns
the read and write paths, a **public lead-capture page** that writes to the CRM without Salesforce,
and an **MCP server** that exposes 17 CRM operations to AI agents over Streamable HTTP.

Everything runs in Docker Compose. Nothing is installed on the host.

> ## Status — what is actually proven
>
> Five capabilities work **end to end inside this repo**, against a real Postgres, real gRPC, real
> Avro decoding, real HTTP and real HTML rendering:
>
> | # | Capability | Evidence (measured, not asserted) |
> |---|---|---|
> | 1 | Bulk import → Postgres | `POST :3002/run/bulk` → `read=19 applied=19 errors=0` (4 accounts, 6 contacts, 6 opportunities, 3 leads) in **2,505 ms**, 613–642 ms per object; a second run changes no row counts |
> | 2 | CDC → Postgres | `POST :4000/mock/emit` → row updated, `cdc_events` `status=applied`, `latency_ms=23`; steady-state latency observed **0–28 ms** over hundreds of events |
> | 3 | Recovery after interruption | `POST /mock/disconnect` (stream killed mid-flight) → events published while nothing was subscribed (`queued:true`) → worker re-subscribed `preset=CUSTOM replay=…`, applied both events at **1,006–1,105 ms**, no duplicate `event_id` |
> | 4 | Public lead capture | `POST /api/leads` → **201**; same email → **200 `duplicate:true`** with the same id; invalid → **400** with per-field errors; 6th rapid submission → **429**; honeypot → **201** decoy and 0 rows; lead visible in `/crm/leads` HTML |
> | 5 | MCP for AI agents | `initialize` + `tools/list` → exactly **17** contract tools; `update_lead_status` → `contacted`, verified through `/api/crm/leads/:id` **and** the rendered page; `POST /mcp` without a token → **401** |
>
> Test suite: **28 files / 218 tests** (5 skipped), green on two consecutive runs of ~25 s each
> (`docker compose run --rm tools pnpm test`, commit `ac527fc`). Typecheck: 6 workspace packages,
> clean. The committed behaviour those numbers cover **includes** the CDC retry / head-of-line block
> / `POST :3002/run/redrive` + `POST :3002/run/discard` path and the `cdc` row in `sync_runs`
> (`2ffb827`, `f327fd4`) — see `docs/FINDINGS.md` §3 for what that does and does not buy. The suite runs against the live compose
> stack (P2-3), so it only passes while nothing else is using it; it restores the canonical demo
> dataset when it finishes.
>
> **The one caveat that matters.** All Salesforce traffic was validated against
> [`apps/salesforce-mock`](apps/salesforce-mock) — a local emulator that implements the published
> Bulk API 2.0 query-job contract (SOQL in the create body, no batch upload, `Sforce-Query-Locator`
> paging), a byte-compatible subset of the Pub/Sub gRPC proto from `forcedotcom/pub-sub-api`, and
> real Avro-encoded CDC payloads with the real `ChangeEventHeader`. **It has never spoken to a real
> Salesforce org.** Everything org-specific — OAuth with an External Client App, real Bulk limits
> and retry semantics, field-level permissions, record types and picklist values, the Pub/Sub 72 h
> retention window — is unverified. See [`docs/FINDINGS.md`](docs/FINDINGS.md) §2 and §4.

---

## Architecture

```text
                Salesforce org                    (here: apps/salesforce-mock, :4000 / :50051)
                     │
      ┌──────────────┴───────────────┐
      │ Bulk API 2.0                 │ Pub/Sub gRPC (Avro CDC)
      │ POST jobs/query              │ Subscribe{replayPreset,replayId}
      │ GET  jobs/query/:id          │
      │ GET  jobs/query/:id/results  │
      └──────────────┬───────────────┘
                     │
              packages/salesforce             (HTTP + gRPC + Avro decode, no SQL)
                     │
                     ▼
              apps/worker  (:3002 control plane)      worker modes: all|bulk|cdc|reconcile|once
                     │  applySalesforceRecord / applySalesforceBatch / deleteSalesforceRecord
                     ▼
                PostgreSQL 16  (:5432)                accounts, contacts, opportunities, leads,
                     ▲                                cdc_events, cdc_checkpoints, sync_runs,
                     │                                sf_orphan_links
      ┌──────────────┴──────────────────────────────┐
      │                                             │
apps/web (Next.js 15, :3000)                  apps/mcp (:3001)
  /crm/**  server components → @poc/core        POST /mcp  Streamable HTTP, stateless
  /lead    public form → POST /api/leads        bearer MCP_AUTH_TOKEN
  /api/crm/**  bearer CRM_API_TOKEN  ◄──────────┘  calls /api/crm/** with CRM_API_TOKEN
                                                 (no SQL in MCP — ever)
                                                     ▲
                                              AI client (Claude Code, Cursor, curl)
```

Two rules the build actually enforces (`docs/CONTRACTS.md` §0.7): **one business-logic layer** — the
UI, the HTTP API and the worker all go through `@poc/core`; and **Salesforce integration stays
isolated** — `packages/salesforce` knows Salesforce, `packages/core` knows the CRM, only the worker
imports both.

### Components

| Component | Path | Port | Role |
|---|---|---|---|
| CRM + public site + internal API | `apps/web` | 3000 | Next.js App Router. `/crm/**`, `/lead`, `/api/crm/**` (21 endpoints), `/api/leads`, `/api/health` |
| Sync worker | `apps/worker` (`packages/salesforce`) | 3002 (control) | Bulk extract, CDC consumer, reconcile; control plane so tests/demos can trigger runs |
| MCP server | `apps/mcp` | 3001 | 17 tools over Streamable HTTP, stateless, bears a token, calls the CRM API |
| Salesforce emulator | `apps/salesforce-mock` | 4000 REST / 50051 gRPC | Bulk query jobs, SOQL, OAuth token, Pub/Sub streaming, Avro schemas, `/mock/*` admin — **loopback only** |
| Domain layer | `packages/core` | — | Entities, SQL, ingest with the stale-write guard, CDC bookkeeping, reporting, migrations |
| Salesforce client | `packages/salesforce` | — | Bulk 2.0 client, gRPC consumer, Avro decode, reconcile. No SQL |
| Database | `db/migrations/001_init.sql` | 5432 | Postgres 16. `poc_crm` + `poc_crm_test` created on first boot |

---

## Quickstart

Prerequisites: **Docker only** (with Compose v2). No Node, no pnpm, no psql, no local Postgres.

```bash
git clone <repo> && cd poc-salesforce-migration
docker compose up -d                      # postgres, salesforce-mock, web, mcp, worker
docker compose run --rm tools pnpm migrate # apply db/migrations/001_init.sql (idempotent)
```

Wait for the healthchecks (`docker compose ps` → `postgres` and `salesforce-mock` report
`healthy`; `web`/`mcp` have healthchecks too, `worker` does not — see `docs/FINDINGS.md` §3).

The worker seeds itself: on boot in `all` mode it runs a bulk extract (unless a bulk run succeeded in
the last 10 minutes) and then starts the CDC consumer on all four topics.

| What | URL | Auth |
|---|---|---|
| CRM | <http://localhost:3000/crm> | none (local POC) |
| Public landing page | <http://localhost:3000/lead> | none, by design |
| Internal CRM API | <http://localhost:3000/api/crm/accounts> | `Authorization: Bearer poc-local-token` |
| MCP (Streamable HTTP) | <http://localhost:3001/mcp> | `Authorization: Bearer poc-local-token` |
| MCP health | <http://localhost:3001/health> | none |
| Worker control plane | <http://localhost:3002/health> | `Authorization: Bearer poc-local-token` |
| Mock admin | <http://localhost:4000/mock/health> | none — **bound to 127.0.0.1** |

Tokens are the compose defaults (`CRM_API_TOKEN` / `MCP_AUTH_TOKEN` = `poc-local-token`). Override
them in `.env` (see `.env.example`) for anything beyond a local demo.

Run the tests and type checks:

```bash
docker compose run --rm tools pnpm test                    # 28 files, 218 tests
docker compose run --rm tools pnpm exec vitest run apps/web/test/e2e   # the five capabilities only (18 tests)
docker compose run --rm tools pnpm typecheck               # 6 packages, tsc --noEmit
```

> ### The hard rule we learned the hard way
>
> **Never run `pnpm install` inside a running container.** All services mount the *same* named
> `node_modules` volumes (`nm_root`, `nm_web`, …). `pnpm install` prunes and relinks `node_modules`,
> which yanks modules out from under `next dev` and `tsx watch` in every other container. The
> containers keep reporting `Up` while they are actually dying on `ERR_MODULE_NOT_FOUND`
> (only `postgres`, `web`, `mcp` and `salesforce-mock` have healthchecks; `worker` will show `Up`
> with a dead process).
>
> Recovery, in this order:
>
> ```bash
> docker compose down                     # stop everything
> docker volume ls | grep nm_            # nm_root nm_web nm_mcp nm_worker nm_mock nm_core nm_sf
> docker volume rm poc-salesforce-migration_nm_root poc-salesforce-migration_nm_web \
>   poc-salesforce-migration_nm_mcp poc-salesforce-migration_nm_worker \
>   poc-salesforce-migration_nm_mock poc-salesforce-migration_nm_core \
>   poc-salesforce-migration_nm_sf
> docker compose build                   # re-populate the volumes from the image (lockfile is frozen)
> docker compose up -d
> ```
>
> If you need a new dependency, do it on purpose: edit `package.json`, then regenerate the lockfile
> with `docker compose run --rm --entrypoint sh tools -c 'pnpm install --lockfile-only'`, rebuild,
> and only then `up -d`. The image builds with `--frozen-lockfile`, so a stale lockfile fails the
> build instead of silently resolving new versions.

---

## The five capabilities — reproduce each in 1–3 commands

All commands assume the stack is up and migrated.

**1. Bulk import** — extract the Salesforce (mock) dataset into Postgres:

```bash
curl -s -X POST localhost:3002/run/bulk -H 'authorization: Bearer poc-local-token' \
  -H 'content-type: application/json' -d '{}'
docker compose exec -T postgres psql -U poc -d poc_crm -c \
  "select source, count(*) from opportunities group by 1;"
```

Expected: `"read":19,"applied":19,"errors":0` and ~2.5 s; `source='salesforce'` rows with
`salesforce_id` preserved. Run it twice — counts do not change.

**2. CDC in near real time** — change a record in "Salesforce" and watch Postgres follow:

```bash
curl -s -X POST localhost:4000/mock/emit -H 'content-type: application/json' -d \
 '{"object":"Opportunity","changeType":"UPDATE","record":{"Id":"006MOCK00004AAAYD2","StageName":"Closed Won","Amount":2600000}}'
docker compose exec -T postgres psql -U poc -d poc_crm -c \
  "select stage, amount from opportunities where salesforce_id='006MOCK00004AAAYD2';"
```

Expected: `Closed Won | 2600000.00` within a second, and a `cdc_events` row with `status=applied`.

**3. Recovery after an interruption** — kill the stream, publish, reconnect:

```bash
curl -s -X POST localhost:4000/mock/disconnect -H 'content-type: application/json' -d '{"topic":"/data/OpportunityChangeEvent"}'
curl -s -X POST localhost:4000/mock/emit -H 'content-type: application/json' -d \
 '{"object":"Opportunity","changeType":"UPDATE","record":{"Id":"006MOCK00003AAAYD2","StageName":"Negotiation","Amount":1337000}}'
docker compose logs --tail=20 worker | grep -E 'reconnect|subscribed|outcome'
```

Expected: the emit answers `"queued":true`; the worker logs `reconnecting in ~1000ms (attempt 1)`,
then `subscribed … preset=CUSTOM replay=<id>` and applies the missed event — no duplicate rows.

**4. Public lead capture** — a visitor becomes a CRM lead with no Salesforce involved:

```bash
curl -s -X POST localhost:3000/api/leads -H 'content-type: application/json' -H 'x-forwarded-for: 198.51.100.10' \
 -d '{"full_name":"Demo Visitor","email":"demo@example.com","consent":true,"property_interest":"Condo"}'
curl -s localhost:3000/lead >/dev/null   # or open it in a browser
```

Expected: `201` with `source:"landing_page"`, `status:"new"`; the lead appears on `/crm` and
`/crm/leads` with a green `Website` badge.

**5. MCP** — an AI agent drives the CRM through 17 tools:

```bash
curl -s -X POST localhost:3001/mcp -H 'authorization: Bearer poc-local-token' \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_sales_summary","arguments":{}}}'
```

Expected: a text summary plus `structuredContent` matching `GET /api/crm/reports/sales-summary`.
Client configuration (Claude Code, Cursor, Codex) and the exact demo prompts are in
[`docs/DEMO.md`](docs/DEMO.md) §5 and [`apps/mcp/README.md`](apps/mcp/README.md).

---

## Demo

The presenter runbook — six demos, exact commands, what to say, expected output, and how to reset
between them — is [`docs/DEMO.md`](docs/DEMO.md). It mirrors checklist §9; Demo 6 is the poison-event
block → alert → fix → redrive → drain walkthrough.

---

## Not production ready

This is a technical validation, and the honest list of what it is not is
[`docs/FINDINGS.md`](docs/FINDINGS.md). In short:

- The Salesforce side is a self-written emulator; no real org has ever been contacted.
- A CDC event that cannot be applied is retried 3× (250 ms / 1 s / 3 s) and then its topic is
  **blocked**: the checkpoint stops at that event and `[cdc][ALERT]` is logged. Nothing is silently
  lost, but the topic stays stalled until someone resolves it — `POST :3002/run/redrive` once the
  data is fixed, or `POST :3002/run/discard {"event_ids":[…]}` when the payload can never apply
  (which leaves that record unapplied, on purpose and on the record). **P0-2 fixed** in `2ffb827`,
  discard in `f327fd4`; the remaining operational limitation is in `docs/FINDINGS.md` §3.
- A replayed or out-of-order `DELETE` from CDC is unguarded: the guard exists in
  `deleteSalesforceRecord`, but the consumer calls it without the event timestamp (**P1-2**, still
  open as committed).
- Rate limiting is per-process memory, in three overlapping buckets; behind no proxy the per-IP
  bucket cannot be used (there is a documented global fallback, not a real limiter).
- A crashed **bulk** run still leaves `sync_runs.status='running'`, which the dashboard renders as
  "Run in progress" indefinitely (a crashed `cdc` run is reaped at consumer startup).
- No outbox, no queue, no lockfile-independent deploys, no observability stack, no secret manager.
- Accounts and contacts have read + create only in the UI; no record-level sharing or FLS.

---

## Documentation map

| Document | What it is |
|---|---|
| [`docs/POC-CHECKLIST.md`](docs/POC-CHECKLIST.md) | The client's checklist, ticked against evidence, with annotations where it is mock-only |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Data model, the four flows, failure modes, design decisions and the alternatives rejected |
| [`docs/FINDINGS.md`](docs/FINDINGS.md) | What was proven, what was not, open defects, production requirements, six-month cutover plan |
| [`docs/DEMO.md`](docs/DEMO.md) | Six-demo runbook |
| [`docs/AUDIT.md`](docs/AUDIT.md) | Adversarial audit of the build (17 findings) — the source of the open-defect list |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md) | The build spec the agents worked from |
| [`docs/AI-ACCELERATORS.md`](docs/AI-ACCELERATORS.md) | Checklist §7 research: Salesforce MCP, AppFlow, EventBridge, HubSpot, deterministic automation |
| [`apps/worker/README.md`](apps/worker/README.md) | Worker modes, control plane, log formats |
| [`apps/mcp/README.md`](apps/mcp/README.md) | Tool catalogue and client configuration |
| [`apps/web/test/e2e/README.md`](apps/web/test/e2e/README.md) | What each capability test asserts |

Layout:

```text
apps/web            Next.js: /crm, /lead, /api/crm/**, /api/leads
apps/worker         Bulk extract + CDC consumer + reconcile + control plane (:3002)
apps/mcp            MCP server (Streamable HTTP, 17 tools)
apps/salesforce-mock  Salesforce emulator (Bulk 2.0, SOQL, Pub/Sub gRPC, Avro)
packages/core       Domain layer, SQL, ingest guard, CDC bookkeeping
packages/salesforce Bulk client, gRPC consumer, Avro, reconcile
db                  Schema + init hook
docker              postgres init script
docs                Checklist, architecture, findings, demo, audit, contracts
```
