# End-to-end suite — the five capabilities, proven against the running stack

These tests are the **Definition of Success** in
[`docs/POC-CHECKLIST.md`](../../../../docs/POC-CHECKLIST.md) turned into
assertions. They talk to the running Docker Compose stack over HTTP — the same
way a browser, a webhook, or an AI agent would. Nothing is mocked in-process:
the worker runs real Bulk API 2.0 query jobs and a real gRPC Pub/Sub consumer
against `apps/salesforce-mock`, and every row lands in the real Postgres.

| File | Capability | What it proves (real assertions) |
|---|---|---|
| `01-bulk.test.ts` | **1. Bulk API 2.0 import** | 11 seeded Salesforce records (3 accounts, 3 contacts, 3 opportunities, 2 leads) land in the CRM over a real Bulk API 2.0 query job: `source='salesforce'`, `salesforce_id` preserved, contacts/opportunities linked to their account (by local uuid), stage/amount/close-date/probability mapped, lead statuses mapped (`Open - Not Contacted` → `new`). `sync_runs` gets a `bulk_extract`/`success` row with the right counts, `GET /health` on the worker reports the finished run, and a **second** run changes no counts (idempotent upsert). |
| `02-cdc.test.ts` | **2. CDC synchronization** | A real Avro event over the real gRPC stream: UPDATE is applied within 15 s with a measured `latency_ms`, CREATE appears with its account link, DELETE removes the row, and an event whose pinned `SystemModstamp` is **older** than the stored row is recorded as `skipped_stale` without regressing the row. The `cdc_events` log has one row per `event_id`. |
| `03-recovery.test.ts` | **3. Recovery after an interruption** | `POST /mock/disconnect` kills the worker's gRPC stream server-side; two events are published while nothing is subscribed (`queued: true`). Both are applied within 30 s through the checkpoint replay (`replayPreset=CUSTOM` from `cdc_checkpoints.replay_id`), the consumer re-subscribes, `cdc_events` has **no duplicate** `event_id`s, and the checkpoint advanced past both replay ids. |
| `04-lead.test.ts` | **4. Public lead capture** | `POST /api/leads` with **no token**: `201` + `source=landing_page` + `status=new` + only the public shape; the same payload again → `200 { duplicate: true }` and no second row; an invalid payload → `400` with per-field `details`; six rapid submissions → `429` + `retry-after` and the blocked one creates nothing. The lead is then visible through `GET /api/crm/leads` and in the **server-rendered HTML** of `/crm/leads`, `/crm/leads/[id]` and `/crm` (website → CRM). |
| `05-mcp.test.ts` | **5. MCP for AI agents** | Streamable HTTP `POST /mcp`: `initialize` + `tools/list` returns **exactly the 17 contract tools** (name-for-name, with annotations); `get_sales_summary` equals `GET /api/crm/reports/sales-summary`; `list_leads` with `source=landing_page` returns the landing-page lead; `update_lead_status` flips it to `contacted`, verified through `GET /api/crm/leads/:id` **and** the rendered `/crm/leads/[id]` page, then the status is restored. MCP without a token → `401`, CRM API without a token → `401`. |

## How to run

```bash
# the whole suite, inside the compose network (what CI/the demo uses)
docker compose run --rm tools pnpm exec vitest run apps/web/test/e2e

# one capability
docker compose run --rm tools pnpm exec vitest run apps/web/test/e2e/03-recovery.test.ts

# the whole repo suite (unit + integration + e2e)
docker compose run --rm tools pnpm test
```

Prerequisites: `docker compose up -d` (all services) and an applied schema
(`docker compose run --rm tools pnpm migrate`). The suite assumes the mock, the
worker (`WORKER_MODE=all`), `web` and `mcp` are already running — it never
starts or restarts a service.

From the host (ports published by compose), point it at localhost:

```bash
E2E_HOST=localhost pnpm exec vitest run apps/web/test/e2e   # host-side, same network names replaced
```

Individual overrides: `E2E_WEB_URL`, `E2E_MOCK_URL`, `E2E_MCP_URL`,
`E2E_WORKER_CONTROL_URL`, plus `CRM_API_TOKEN` / `MCP_AUTH_TOKEN` (default
`poc-local-token`). `cleanupE2EData()` needs `DATABASE_URL` because it deletes
rows through `@poc/core` (the CRM API deliberately exposes no deletes).

## Determinism and cleanup

* **Unique per run.** Every id and email carries a `E2E<6 hex>` marker
  (`RUN` in `helpers.ts`), so two runs never collide and the same suite can run
  twice in a row. `e2eId()` throws rather than silently truncating two ids to
  the same 15-char Salesforce base.
* **Order independence.** Each file prepares what it needs (`prepareE2EDataset`
  re-seeds pristine, freshly-stamped E2E rows next to the live demo rows) and
  cleans up after itself. Files are not required to run in numeric order; the
  root config uses `singleFork`, so they never overlap.
* **The demo data is never touched.** `/mock/reset` is never called. The mock's
  demo dataset is read from `/mock/state` and seeded again unchanged next to the
  E2E rows (`/mock/seed` replaces the dataset, so it is always passed as
  "current demo rows + this run's rows"). `afterAll` deletes only rows matching
  the run marker / run-scoped email prefix and restores the mock to demo-only.
* **Timeouts.** Each capability is one `describe` with a 60 s timeout
  (`describe(name, { timeout: 60_000 })`), and every wait is an explicit
  `poll(fn, { timeout, label })` — no fixed sleeps.
* **Hot reload.** `worker` and `salesforce-mock` run under `tsx watch`, so a
  source edit restarts them. `fetchWithRetry` retries transport errors (never
  HTTP statuses), and `bulkRun()` retries both a dropped connection and the
  worker's `409` single-flight lock.

## Notes on the fixtures

* **Why the worker has a control endpoint.** A test cannot execute `docker`
  inside the container, so the worker exposes `POST /run/bulk` on
  `PORT_CONTROL` (3002, bearer `CRM_API_TOKEN`) — see
  [`apps/worker/README.md`](../../../worker/README.md). It runs the same
  `runBulkExtract()` the CLI does and answers with the run summary.
* **Stale-write guard via HTTP.** `POST /mock/emit` stamps the event with "now"
  unless the record carries an explicit `SystemModstamp`. `02-cdc.test.ts` pins
  an old stamp to prove an out-of-order event cannot regress a newer row.
* **Rate limits are per process.** `apps/web` keeps the three lead buckets
  (per IP 5/10 min, per email 2/10 min, global 60/10 min) in module memory, so a
  dev-server restart clears them. Each test uses a dedicated `x-forwarded-for`
  address (`e2eIp(label)`) and `beforeAll` warms the route on a throw-away
  bucket, so a cold compile cannot consume the bucket under test.
* **Test 5 can recreate its lead.** Test 4 deletes the rows it created, so if
  test 5 runs afterwards it recreates the same landing-page lead — through the
  public endpoint when the per-email bucket allows it, otherwise through
  `createLead()` (the service the route itself calls). The MCP assertions are
  identical either way.
