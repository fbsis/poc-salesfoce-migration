# Demo runbook — six demos

Checklist §9. Each demo is a numbered runbook of exact commands (paste them), what to say while it
runs, the expected output, and how to reset. Total run time ≈ 25 minutes.

Prerequisites, once:

```bash
cd poc-salesforce-migration
docker compose up -d          # postgres, salesforce-mock, web, mcp, worker
docker compose run --rm tools pnpm migrate
```

Open three terminals if you want to narrate and run at the same time:

| Terminal | Use |
|---|---|
| A | `docker compose logs -f worker` — the sync evidence, live |
| B | `docker compose exec postgres psql -U poc -d poc_crm` — the database |
| C | the demo commands below |

> **Before you start:** `pnpm test` restores the canonical demo dataset when it finishes
> (`FINDINGS.md` §3, P2-3), but it runs against this same live stack and takes ~25 s. If the last run
> was interrupted, check `/mock/health` returns `4/6/6/3` and run the reset below; never start a demo
> with the worker still blocked on a `failed` event (`docs/FINDINGS.md` §3).

---

## Reset between demos

Paste this whenever a demo changed data and you want the pristine dataset back. It is the only
supported way to reset (the mock's dataset is in memory; the CRM holds rows derived from it).

```bash
docker compose restart salesforce-mock
sleep 6
curl -s localhost:4000/mock/health
docker compose exec -T postgres psql -U poc -d poc_crm -c "BEGIN;
  DELETE FROM cdc_events; DELETE FROM cdc_checkpoints; DELETE FROM sync_runs;
  DELETE FROM opportunities; DELETE FROM contacts; DELETE FROM accounts;
  DELETE FROM leads WHERE source <> 'landing_page'; COMMIT;"
curl -s -X POST localhost:3002/run/bulk \
  -H 'authorization: Bearer poc-local-token' -H 'content-type: application/json' -d '{}' | head -c 200
```

Expected `/mock/health`: `"dataset":{"accounts":4,"contacts":6,"opportunities":6,"leads":3}`, and
after the bulk call `"status":"success"` with `"totals":{"read":19,"applied":19,...,"errors":0}`.

**Do not restart the mock without truncating the CRM.** The re-seeded dataset carries its original
2024 timestamps, so the stale-write guard correctly refuses to overwrite local rows that a previous
`/mock/emit` stamped with 2026 — you would see `skipped_stale: 2` and two rows stuck at old demo
values. That is the guard working, not a bug; truncate and re-extract instead.

Landing-page leads (`source='landing_page'`) are kept by the reset on purpose — they never came from
Salesforce.

---

## Demo 1 — Salesforce migration (Bulk API 2.0 → Postgres → CRM)

**Say:** "We're reading Salesforce with a Bulk API 2.0 query job — SOQL goes in the create body, we
poll the job to `JobComplete`, then read the CSV result pages. Records are upserted into Postgres
keyed on the Salesforce id, so re-running it changes nothing."

1. Show the empty/current state:

```bash
docker compose exec -T postgres psql -U poc -d poc_crm -c \
  "select source, count(*) from accounts group by 1;"
```

2. Run the extract (synchronous — when it returns, the rows are in Postgres):

```bash
curl -s -X POST localhost:3002/run/bulk \
  -H 'authorization: Bearer poc-local-token' -H 'content-type: application/json' -d '{}'
```

3. Show what landed, including preserved ids and resolved relationships:

```bash
docker compose exec -T postgres psql -U poc -d poc_crm -c \
  "select salesforce_id, name, industry, source from accounts order by name;" \
  -c "select o.name, o.stage, o.amount, a.name as account, o.source
        from opportunities o join accounts a on a.id = o.account_id order by o.amount desc;"
```

4. Open <http://localhost:3000/crm> and <http://localhost:3000/crm/opportunities>.

5. Prove idempotency: run step 2 again, then re-run step 1 — counts unchanged.

**Expected output (real, from a full run):** `"status":"success"`, `"durationMs":2505`,
`"totals":{"read":19,"applied":19,"skipped_stale":0,"ignored":0,"errors":0}`, per-object
`Account 4` (642 ms), `Contact 6` (613 ms), `Opportunity 6` (634 ms), `Lead 3` (612 ms). Accounts
show `001MOCK00001AAAYD2 | Skyline Realty Group | Residential Real Estate | salesforce`, and every
opportunity has an `account` name — the local FK was resolved from the Salesforce parent id.

**Say:** "The dashboard is reading the same tables the sync wrote — one business-logic layer, the UI
never talks to Salesforce."

---

## Demo 2 — CDC: change a record in Salesforce, watch the CRM follow

The checklist says "modify an Opportunity in Salesforce". The mock has no record-edit UI: the
equivalent action is `POST /mock/emit`, which **mutates the mock's dataset and publishes a real CDC
event over the real gRPC stream with real Avro encoding** — exactly what an org-side edit produces.
Say that out loud; do not imply a Salesforce UI is behind it.

**Say:** "Salesforce now changes a record. The worker is subscribed to four CDC topics over the
Pub/Sub gRPC API, decodes the Avro payload, and applies it — with a guard so an older event can
never overwrite a newer row."

1. Show the row before:

```bash
docker compose exec -T postgres psql -U poc -d poc_crm -c \
  "select salesforce_id, stage, amount from opportunities where salesforce_id='006MOCK00004AAAYD2';"
```

2. Change it in "Salesforce":

```bash
curl -s -X POST localhost:4000/mock/emit -H 'content-type: application/json' -d '{
  "object":"Opportunity","changeType":"UPDATE",
  "record":{"Id":"006MOCK00004AAAYD2","StageName":"Closed Won","Amount":2600000}}'
```

3. Two seconds later, read it back and look at the event log:

```bash
sleep 2
docker compose exec -T postgres psql -U poc -d poc_crm -c \
  "select stage, amount, salesforce_updated_at from opportunities where salesforce_id='006MOCK00004AAAYD2';" \
  -c "select event_id, change_type, status, latency_ms from cdc_events order by received_at desc limit 3;"
```

4. Show it in the UI: <http://localhost:3000/crm/opportunities> (stage becomes `Closed Won`), and
   the **Salesforce sync** card on <http://localhost:3000/crm>. The card now reflects the live
   consumer: the pill reads **"Run in progress"** (amber) for as long as the worker owns its `cdc`
   sync run, "Last CDC event" shows the event you just applied with a lag of a second or two, and
   the checkpoint list shows `connected · replay <id>` per channel.

```bash
docker compose exec -T postgres psql -U poc -d poc_crm -c \
  "select kind, status, records_read, records_written, details->>'close_reason' as closed, started_at
     from sync_runs order by started_at desc limit 3;"
```

That is the row behind the pill: one open `kind='cdc'` row per consumer lifetime (it closes when the
consumer stops, with p50/max latency in `details`), not one per event.

**Expected output:** before `Negotiation | 2400000.00`; the emit answers
`{"ok":true,...,"changedFields":["StageName","Amount","Probability","LastModifiedDate","SystemModstamp"],"delivered":1,"queued":false}`;
after `Closed Won | 2600000.00`; `cdc_events` has one row, `status=applied`, `latency_ms` in the
**low tens of milliseconds** (23 ms observed; 0–28 ms across hundreds of events). The worker log line
is `[cdc] Opportunity UPDATE 006MOCK00004AAAYD2 replay=… latency=23 outcome=applied`.

**Say:** "The latency is measured from the Salesforce commit timestamp to the write, and it's stored
on the event — not estimated."

---

## Demo 3 — CDC recovery: disconnect the consumer, change a record, reconnect, replay

**Say:** "Consumers fail. The interesting question isn't whether it reconnects, it's whether it
misses anything while it's down. Watch: I kill the stream server-side, make a change with nobody
listening, and the worker resumes from its persisted checkpoint."

1. Kill the stream for one topic:

```bash
curl -s -X POST localhost:4000/mock/disconnect \
  -H 'content-type: application/json' -d '{"topic":"/data/OpportunityChangeEvent"}'
```

2. Change a record while nothing is subscribed:

```bash
curl -s -X POST localhost:4000/mock/emit -H 'content-type: application/json' -d '{
  "object":"Opportunity","changeType":"UPDATE",
  "record":{"Id":"006MOCK00003AAAYD2","StageName":"Negotiation","Amount":1337000}}'
```

Note `"queued":true` and `"delivered":0` in the response — the event is waiting, not lost.

3. Watch the recovery (terminal A, or this):

```bash
sleep 6
docker compose logs --tail=40 worker | grep -E 'reconnect|subscribed|outcome='
```

4. Confirm the row and the checkpoint:

```bash
docker compose exec -T postgres psql -U poc -d poc_crm -c \
  "select stage, amount from opportunities where salesforce_id='006MOCK00003AAAYD2';" \
  -c "select replay_id, last_event_at, status from cdc_checkpoints where channel='/data/OpportunityChangeEvent';"
```

**Expected output:** the emit answers `"delivered":0,"queued":true`. The logs show
`stream closed (end)` → `reconnecting in 1072ms (attempt 1, channel=/data/OpportunityChangeEvent)` →
`subscribed channel=… preset=CUSTOM replay=1795653255416179 num_requested=100` →
`Opportunity UPDATE 006MOCK00003AAAYD2 replay=1795653255416180 latency=1105 outcome=applied`. The row
is `Negotiation | 1337000.00`, and the checkpoint's `replay_id` is the replayed event's id.

**Say:** "`preset=CUSTOM` means it resumed from the checkpoint in Postgres, not from the tip. The
latency is a full second because the event waited for the reconnect — that is the replay, measured.
And because `event_id` is unique, a double delivery can't double-apply."

**Then say — this is important and honest:** "This is recovery from a *clean* disconnect. The harder
case is an event that cannot be applied at all. That does not lose the change: the worker retries it
three times, then stops that topic's checkpoint instead of stepping over it, logs an alert, and waits
for me to fix the data and redrive — one topic stalls, nothing disappears. That is Demo 6, and the
tradeoff is written up in `docs/FINDINGS.md` §3."

---

## Demo 4 — Public lead registration (no Salesforce involved)

**Say:** "This is the business workflow that doesn't need Salesforce at all: a visitor on the public
site becomes a lead in the CRM. The landing page talks to a public endpoint, which validates, rate
limits, deduplicates and writes straight to Postgres — never to the CRM admin API."

1. Open <http://localhost:3000/lead> — title "Find Your Next Home", the form, the consent checkbox.

2. Submit a lead from the UI (or from the terminal):

```bash
curl -s -X POST localhost:3000/api/leads -H 'content-type: application/json' \
  -H 'x-forwarded-for: 198.51.100.10' -d '{
  "full_name":"Demo Visitor","email":"demo.visitor@example.com","phone":"+1 305 555 0111",
  "property_interest":"Waterfront condo","message":"Looking for a 2-bedroom.","consent":true}'
```

3. Show the same email again (duplicate), and an invalid payload:

```bash
curl -s -X POST localhost:3000/api/leads -H 'content-type: application/json' \
  -H 'x-forwarded-for: 198.51.100.11' \
  -d '{"full_name":"Demo Visitor","email":"demo.visitor@example.com","consent":true}'

curl -s -X POST localhost:3000/api/leads -H 'content-type: application/json' \
  -H 'x-forwarded-for: 198.51.100.12' \
  -d '{"full_name":"A","email":"nope","consent":false}'
```

4. Show it in the CRM: <http://localhost:3000/crm/leads> — green `Website` badge, status `New`.
   Open the lead and set the status to `Contacted`.

**Expected output:**

```json
{"data":{"id":"…","status":"new","source":"landing_page","created_at":"2026-11-26T…Z"}}                       HTTP 201
{"data":{"id":"<same id>","status":"new", …},"duplicate":true}                                               HTTP 200
{"error":{"code":"validation_error","message":"Please correct the highlighted fields",
 "details":{"full_name":"Please enter your full name","email":"Please enter a valid email address",
            "consent":"Please accept the privacy notice"}}}                                                 HTTP 400
```

**Say:** "The duplicate returns 200 with the *same* id and writes no row — and it's atomic, an
advisory lock on the email, because two people can hit submit at the same time. Six rapid
submissions get a 429, and the hidden honeypot field returns a fake success while storing nothing."

Optional, if asked about spam: "the per-IP bucket needs `X-Forwarded-For` from a trusted proxy;
without one, a documented global bucket plus a per-email guard applies. That's a demo-grade limiter,
not production."

---

## Demo 5 — AI agent via MCP

**Say:** "The agent never touches the database. It calls MCP tools over Streamable HTTP; the MCP
server calls the internal CRM API with its own token. Every tool is zod-validated, every call is
logged by tool name and argument keys only — no lead PII in the logs."

### 5a. Configure a real AI client

Claude Code (`.mcp.json` in the repo, or `~/.claude.json`), Cursor (`.cursor/mcp.json`), or Claude
Desktop (`claude_desktop_config.json`) — same block:

```json
{
  "mcpServers": {
    "poc-crm": {
      "type": "http",
      "url": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer poc-local-token" }
    }
  }
}
```

Claude Code CLI equivalent:

```bash
claude mcp add --transport http poc-crm http://localhost:3001/mcp \
  --header "Authorization: Bearer poc-local-token"
```

Codex (`~/.codex/config.toml`):

```toml
experimental_use_rmcp_client = true

[mcp_servers.poc_crm]
url = "http://localhost:3001/mcp"
bearer_token_env_var = "POC_CRM_TOKEN"   # export POC_CRM_TOKEN=poc-local-token
```

Then ask, in the client, in this order:

| # | Prompt (exactly as in checklist §6/§9) | Expected |
|---|---|---|
| 1 | `Show me the latest leads captured through our website.` | `list_leads` with `source=landing_page`; the lead from Demo 4, newest first |
| 2 | `Find the latest lead and change its status to Contacted.` | `search_leads`/`list_leads` then `update_lead_status` → `contacted` |
| 3 | `Show me all opportunities currently in the Negotiation stage.` | `list_opportunities` with `stage=Negotiation` |
| 4 | `Summarize the current pipeline and show the total expected revenue.` | `get_sales_summary` → pipeline value in USD |
| 5 | `Create a new opportunity for Acme Real Estate worth $15,000.` | `get_account`(Acme) then `create_opportunity`; visible in `/crm/opportunities` |
| 6 | `Check when Salesforce was last synchronized and report any errors.` | `get_sync_status` → last bulk run, per-topic checkpoints, `failedEvents` |

### 5b. Fallback: raw JSON-RPC (no AI client needed)

```bash
TOKEN=poc-local-token
curl -s -X POST localhost:3001/mcp -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

curl -s -X POST localhost:3001/mcp -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -c '"name"'

curl -s -X POST localhost:3001/mcp -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_sales_summary","arguments":{}}}'
```

Update a lead's status (replace the id with the one from Demo 4):

```bash
LEAD=<lead-uuid>
curl -s -X POST localhost:3001/mcp -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"update_lead_status\",\"arguments\":{\"id\":\"$LEAD\",\"status\":\"contacted\"}}}"
```

Then verify the agent's write in the CRM UI, and verify the guard:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3001/mcp \
  -H 'content-type: application/json' -d '{}'          # 401 — no token
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/crm/accounts   # 401 — no token
```

**Expected output:** `initialize` → `serverInfo.name` `poc-crm-mcp`, `protocolVersion` `2025-06-18`,
17 tools listed. `get_sales_summary` returns a human summary **and** `structuredContent` that
matches `GET /api/crm/reports/sales-summary` exactly:

```
Sales summary — 19 Salesforce record(s), 9 local
accounts      4
contacts      6
opportunities 6 (open: 4)
pipeline      $4,395,000.00
won           $3,150,000.00
leads         12 (new: 7)
```

`update_lead_status` returns `Lead <name> <email> is now "contacted" (id: …)`, and the lead page
shows `Contacted`. Both untokened calls return `401`. The counts above are the state right after the
reset on this page; yours will differ by whatever Demo 4 created.

**Say:** "That is website → CRM → MCP → agent, with the agent's write visible in the same UI a human
uses. What I have not done is drive it from a real model — the checklist item for that is left
unticked, and the prompts above are the script to close it."

---

## Demo 6 — a poison event blocks its topic, the alert fires, then redrive (or deliberately discard)

This is the sharpest demonstration of the P0-2 fix, and the honest one: the system **refuses to skip
a change it cannot apply**. One unappliable event stops its own topic — visibly — and nothing behind
it is lost.

**Say:** "Every sync has a version of this question: what happens when an event cannot be applied?
The old answer — mark it failed and move on — loses the change forever. Watch what happens instead."

1. Confirm the starting state (row + checkpoint):

```bash
docker compose exec -T postgres psql -U poc -d poc_crm -c \
  "select stage, amount from opportunities where salesforce_id='006MOCK00002AAAYD2';" \
  -c "select status, replay_id from cdc_checkpoints where channel='/data/OpportunityChangeEvent';"
```

Expected: `Qualification | 265000.00`, checkpoint `connected`.

2. Publish an event whose data the CRM cannot map (a real org-side picklist value the POC has never
   seen). `/mock/emit` accepts any record, so this is a genuine apply-time failure:

```bash
curl -s -X POST localhost:4000/mock/emit -H 'content-type: application/json' -d '{
  "object":"Opportunity","changeType":"UPDATE",
  "record":{"Id":"006MOCK00002AAAYD2","StageName":"Closed Won – Renewal","Amount":900000}}'
```

3. Watch the retries and the alert (terminal A, or this):

```bash
sleep 6
docker compose logs --tail=40 worker | grep -E 'RETRY|ALERT|reconnecting|subscribed'
```

Expected, in order: three `[cdc][RETRY] … attempt=1/3 … 3/3 error=unmapped StageName: "Closed Won –
Renewal"` lines, then `[cdc][ALERT] … apply failed after 3 attempts; checkpoint NOT advanced
(blocked). Fix or redrive.`, then `stream error: … CANCELLED`, `reconnecting in ~1200ms`, and
`subscribed … preset=CUSTOM replay=<the same checkpoint>` — it comes back to the same place, not the
tip.

4. Show that the checkpoint held and the row was **not** written:

```bash
docker compose exec -T postgres psql -U poc -d poc_crm -c \
  "select event_id, status, left(error,70) as error from cdc_events where status='failed';" \
  -c "select channel, status, replay_id from cdc_checkpoints where channel='/data/OpportunityChangeEvent';" \
  -c "select stage, amount from opportunities where salesforce_id='006MOCK00002AAAYD2';"
```

Expected: one `failed` row carrying the payload and the error, the checkpoint at
`status='error'` with its **old** `replay_id`, and the opportunity still `Qualification |
265000.00`. Nothing was lost and nothing was half-applied.

Also open <http://localhost:3000/crm>: the sync card's `failed` counter is now 1 and the checkpoint
list shows `error · replay <id>` for that channel. The other three channels are still `connected`.

5. Redrive while the data is still broken — it reports, it does not lie:

```bash
curl -s -X POST localhost:3002/run/redrive \
  -H 'authorization: Bearer poc-local-token' -H 'content-type: application/json' -d '{"limit":50}'
```

Expected: `{"attempted":1,"applied":0,"skipped_stale":0,"ignored":0,"still_failing":1}`.

Now pick **one** branch. Both end with the topic draining; they differ in what happens to the record.

### Option A — the data can be fixed: redrive it

6. Fix the event's data and redrive again:

```bash
docker compose exec -T postgres psql -U poc -d poc_crm -c \
  "update cdc_events set payload = jsonb_set(payload, '{StageName}', '\"Negotiation\"')
     where status='failed';"
curl -s -X POST localhost:3002/run/redrive -H 'authorization: Bearer poc-local-token'
```

Expected: `{"attempted":1,"applied":1,"skipped_stale":0,"ignored":0,"still_failing":0}`.

7. Watch the topic drain (within the current backoff, at most 30 s):

```bash
sleep 20
docker compose logs --tail=30 worker | grep -E 'unblocked|duplicate|outcome='
docker compose exec -T postgres psql -U poc -d poc_crm -c \
  "select status, replay_id from cdc_checkpoints where channel='/data/OpportunityChangeEvent';" \
  -c "select stage, amount from opportunities where salesforce_id='006MOCK00002AAAYD2';"
```

Expected: `[cdc] /data/OpportunityChangeEvent unblocked (no failed events remain at replay=…),
resuming`, the redelivered event logged as `outcome=duplicate`, the checkpoint back to `connected`
with the **new** replay id, and the row now `Negotiation | 900000.00`. Everything that queued behind
the poison event applies in order.

If `still_failing` is 1 again, you raced the consumer's own retry of the same event: run step 6's
`redrive` once more. If the row is missing, the demo's reset (below) is the way back.

### Option B — the payload can never apply: discard it deliberately

This is the escape hatch for an event whose data is unrepairable (a value the CRM will never map, a
constraint it will never satisfy). Use it **instead of** Option A on the same event.

6. Abandon that event, by id, and let the checkpoint move past it:

```bash
EVENT=$(docker compose exec -T postgres psql -U poc -d poc_crm -tAc \
  "select event_id from cdc_events where status='failed' limit 1")
echo "$EVENT"
curl -s -X POST localhost:3002/run/discard \
  -H 'authorization: Bearer poc-local-token' -H 'content-type: application/json' \
  -d "{\"event_ids\":[\"$EVENT\"]}"
```

Expected: `{"discarded":["/data/OpportunityChangeEvent:…"],"not_found":[],
"checkpoint_advanced":{"/data/OpportunityChangeEvent":"…"}}`.

7. Show what was and was not done:

```bash
docker compose exec -T postgres psql -U poc -d poc_crm -c \
  "select event_id, status, left(error,55) as reason from cdc_events order by received_at desc limit 2;" \
  -c "select stage, amount from opportunities where salesforce_id='006MOCK00002AAAYD2';" \
  -c "select status, replay_id from cdc_checkpoints where channel='/data/OpportunityChangeEvent';"
```

Expected: the event row is `ignored` with `discarded by operator (event abandoned; the record was not
applied)`, the opportunity is still `Qualification | 265000.00` — **the change is gone on purpose** —
and the checkpoint is past it (`connected` within ~30 s, when the consumer next subscribes and logs
`unblocked`). The row stays in `cdc_events` as `ignored`, so the decision is auditable, and the next
bulk extract or a corrected `UPDATE` is what repairs the record.

**Say (whichever branch you took):** "The tradeoff is explicit: one topic stalled, everything else
kept flowing, and no change was dropped silently. A retry loop in the background would have hidden
the unmapped picklist value forever — the alert is the product here. And when the data can never
apply, abandoning it is a visible, logged, per-event decision rather than a `failed` row nobody looks
at. That is `docs/FINDINGS.md` §3."

**Reset after this demo is mandatory:** the mock's dataset now holds the unmapped `StageName`, so a
later bulk extract would (correctly) fail on it. Paste the reset at the top of this page, and confirm
`cdc_checkpoints` shows four `connected` channels.

---

## Closing slide material

| Capability | One-line proof | Honest caveat |
|---|---|---|
| Bulk import | 19 records, 2.5 s, idempotent | Salesforce is an emulator |
| CDC | 0–28 ms apply latency | 72 h retention modelled as a 1,000-event buffer |
| Recovery | replay after a killed stream, no duplicates; a poison event blocks its topic and is redriven | one blocked topic stalls until its data is fixed (`FINDINGS.md` §3) |
| Lead capture | 201 / 200 duplicate / 400 / 429 / honeypot | limiter is per-process memory |
| MCP | 17 tools, writes visible in the UI, 401 by default | no real model has driven it |

Full detail: [`FINDINGS.md`](FINDINGS.md) · [`ARCHITECTURE.md`](ARCHITECTURE.md) ·
[`AUDIT.md`](AUDIT.md)
