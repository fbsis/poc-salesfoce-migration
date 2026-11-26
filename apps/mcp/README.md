# @poc/mcp — CRM MCP server

An [MCP](https://modelcontextprotocol.io) server that exposes the POC CRM as **17 tools** so an AI
agent can read and maintain accounts, opportunities, leads and Salesforce-sync health.

It never touches Postgres. Every tool is a thin wrapper over the internal CRM HTTP API
(`apps/web/app/api/crm/**`, see `docs/CONTRACTS.md` §4), authenticated with `CRM_API_TOKEN`.

```
MCP client ──(Streamable HTTP + bearer, :3001)──> @poc/mcp ──(bearer, :3000)──> /api/crm/*
```

## Run it

Everything runs in Docker (never install on the host):

```bash
docker compose up -d mcp                        # start (or: docker compose up -d --force-recreate mcp)
docker compose logs -f mcp                      # structured JSON logs, one line per request
docker compose run --rm tools pnpm --filter @poc/mcp exec tsc --noEmit   # typecheck
docker compose run --rm tools pnpm exec vitest run apps/mcp/test         # offline tests
```

The container runs `pnpm --filter @poc/mcp run dev` (`tsx watch src/index.ts`), so edits reload.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_PORT` | `3001` | HTTP listen port (binds `0.0.0.0`) |
| `MCP_AUTH_TOKEN` | — | Bearer token clients must send on `/mcp`. Empty ⇒ every call is rejected |
| `CRM_API_BASE_URL` | `http://web:3000` | Internal CRM API origin |
| `CRM_API_TOKEN` | — | Bearer token the server sends to the CRM API |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

## Transport & auth

- **Streamable HTTP**, endpoint `POST /mcp` (JSON-RPC 2.0). `GET /mcp` and `DELETE /mcp` are routed
  too, but a stateless server has no server-initiated stream and no session, so the transport
  answers `405` there. That is expected — see the note below.
- **Auth**: `Authorization: Bearer ${MCP_AUTH_TOKEN}` on `/mcp`. Missing or wrong token ⇒
  `401 {"error":{"code":"unauthorized","message":"…"}}`, returned *before* any CRM call.
  Comparison is constant-time (sha256 + `timingSafeEqual`). `GET /health` is open (container probe).
- **Stateless**: `sessionIdGenerator: undefined` and a **fresh `McpServer` + transport per request**
  (the SDK's documented stateless pattern). Consequences for clients:
  - no `Mcp-Session-Id` response header, no session to `DELETE`;
  - `initialize` → `notifications/initialized` → `tools/list` → `tools/call` are independent
    requests; you must not depend on state carried between them;
  - `Accept: application/json, text/event-stream` is recommended (the transport may answer as SSE).
  A client that requires a stateful session (some older Cursor builds) still works: it sends the
  bearer token on every request and simply gets no session header back.
- **Health**: `GET /health` → `{ "status": "ok", "tools": 17, "upstream": "ok" | "unreachable" }`.
  `upstream` is `ok` only when `GET /api/crm/accounts?limit=1` answers 2xx.

## Tool catalogue

Reads are annotated `readOnlyHint: true`; creates `destructiveHint: false`; updates
`destructiveHint: false, idempotentHint: true`. Every tool returns compact text in `content`
(a small aligned table for lists, max 10 rows + "…and N more") **and** the raw API payload in
`structuredContent`.

**All `id` arguments accept either the local uuid or the Salesforce id** (`001…` account,
`006…` opportunity, `00Q…` lead). Errors come back as `isError: true` with `code: message` — never
a stack trace.

| Tool | Arguments | Returns |
|---|---|---|
| `list_accounts` | `search?`, `limit?`, `offset?` | `{ data, meta }` |
| `get_account` | `id` | `{ data }` |
| `search_accounts` | `term`, `limit?` | `{ data }` (array) |
| `create_account` | `name`, `industry?`, `website?`, `billing_country?`, `owner_name?` | `{ data }` |
| `update_account` | `id`, `name?`, `industry?`, `website?`, `billing_country?`, `owner_name?` | `{ data }` |
| `list_opportunities` | `stage?`, `search?`, `account_id?`, `limit?`, `offset?` | `{ data, meta }` |
| `get_opportunity` | `id` | `{ data }` |
| `create_opportunity` | `name`, `account_id?`, `stage?`, `amount?`, `close_date?`, `owner_name?` | `{ data }` |
| `update_opportunity` | `id`, `name?`, `account_id?`, `stage?`, `amount?`, `close_date?`, `owner_name?`, `probability?` | `{ data }` |
| `list_leads` | `status?`, `source?`, `search?`, `created_since?`, `limit?`, `offset?` | `{ data, meta }` |
| `get_lead` | `id` | `{ data }` |
| `search_leads` | `term`, `limit?` | `{ data }` (array) |
| `update_lead_status` | `id`, `status` | `{ data }` |
| `get_sales_summary` | — | counters + pipeline/won USD |
| `get_opportunities_by_stage` | — | `[{ stage, count, totalAmount }]` |
| `get_lead_summary` | `since?` | totals, by status/source, latest leads |
| `get_sync_status` | — | bulk run, CDC lag, checkpoints, event counters |

Enums: opportunity `stage` = `Prospecting | Qualification | Proposal | Negotiation | Closed Won |
Closed Lost`; lead `status` = `new | contacted | qualified | closed`; lead `source` =
`landing_page | salesforce | manual`. Amounts are USD; dates are ISO (`YYYY-MM-DD` for input).

## Client configuration

Cursor and Claude Desktop/Code expect the servers under a top-level `mcpServers` key; Codex
(`~/.codex/config.toml`) uses TOML with `experimental_use_rmcp_client = true`.

### Cursor — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)

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

### Claude Code — `.mcp.json` in the repo, or `~/.claude.json`

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

CLI equivalent:

```bash
claude mcp add --transport http poc-crm http://localhost:3001/mcp \
  --header "Authorization: Bearer poc-local-token"
```

### Claude Desktop — `claude_desktop_config.json`

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

### Codex — `~/.codex/config.toml`

```toml
experimental_use_rmcp_client = true

[mcp_servers.poc_crm]
url = "http://localhost:3001/mcp"
bearer_token_env_var = "POC_CRM_TOKEN"   # export POC_CRM_TOKEN=poc-local-token
```

### Other clients (VS Code, custom SDK clients, curl)

Anything that speaks Streamable HTTP works. The same server also speaks plain JSON-RPC, so a quick
smoke test is:

```bash
TOKEN=poc-local-token
curl -s localhost:3001/health
curl -s -i -X POST localhost:3001/mcp -H 'content-type: application/json' -d '{}'   # 401

# initialize (stateless: no session id comes back)
curl -s -X POST localhost:3001/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# tools/list
curl -s -X POST localhost:3001/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# a real tool call
curl -s -X POST localhost:3001/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_sales_summary","arguments":{}}}'
```

## Layout

```
src/
  index.ts            Express app: /health, POST|GET|DELETE /mcp, auth, logging, SIGTERM
  server.ts           McpServer factory (name poc-crm-mcp, version from package.json)
  crm-client.ts       typed HTTP client: bearer, 8s AbortSignal.timeout, CrmApiError
  auth.ts             constant-time bearer middleware for /mcp
  logger.ts           one-line JSON logs
  tools/
    index.ts          registry — returns the 17 registered names
    accounts.ts       5 tools
    opportunities.ts  4 tools
    leads.ts          4 tools
    reporting.ts      4 tools
    shared.ts         result envelope, error mapping, money/date formatting, table renderer
test/mcp.test.ts      offline: registration, crm-client, list_opportunities, auth
```

## Notes / deviations

- `search_accounts` and `search_leads` have no dedicated API route; they call
  `GET /api/crm/accounts|leads?search=<term>&limit=<n>` and return `{ data }` (array), matching the
  `searchAccounts` / `searchLeads` service semantics.
- `list_opportunities` and `list_leads` append a `Next page: offset=…` hint to the text summary
  when `meta.total` exceeds the rows returned.
- Logs record `rpc_method`, `tool`, `arg_keys`, `status`, `duration_ms` and `outcome`. They never
  log argument values, so lead payloads (PII) stay out of `docker compose logs`.
- No dependencies were added; it uses the installed `@modelcontextprotocol/sdk` (1.32.x),
  `express`, `cors`, `zod` and `dotenv`.
