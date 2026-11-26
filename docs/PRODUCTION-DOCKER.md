# Running this POC in production with Docker

The repo ships a **dev-mode** stack: `docker-compose.yml` bind-mounts the checkout, sets `NODE_ENV=development`, runs `next dev` / `tsx watch`, keeps rate limits in process memory, includes a Salesforce mock, and sets `restart: "no"`. This document is the delta: `web` becomes N replicas of a standalone Next build, `mcp` N replicas, the `worker` a supervised singleton, Postgres a managed service, and the mock disappears. It extends [`FINDINGS.md`](FINDINGS.md) §4 and the open defects in §3.

---
## 1. Production topology

```mermaid
flowchart TB
  U[Lead form / browser] --> PX
  AI[AI client] --> PX
  OPS[Operator / CI] --> PX
  PX["TLS ingress Caddy/Traefik<br/>crm.example.com + mcp.example.com"] --> W["web ×1..N :3000"]
  PX --> M["mcp ×1..N :3001"]
  W --> PG[("managed PostgreSQL 16<br/>TLS, PITR")]
  W -.->|"phase 2"| RD[("Redis<br/>rate limit")]
  M -->|"CRM_API_BASE_URL"| W
  WK["worker ×1 (singleton)<br/>Bulk + CDC + :3002"] --> PG
  MG["migrate (one-shot)"] --> PG
  WK -->|"OAuth + Bulk API 2.0"| SF[Salesforce REST]
  SF -->|"CDC Avro over gRPC"| PS["Pub/Sub :7443"] --> WK
```

`salesforce-mock` is absent by design: `/mock/*` is unauthenticated by contract, and in production that is an unauthenticated write endpoint onto CRM data — keep it out of the prod image targets, not just out of the compose file. **Scales:** `web` (every route `force-dynamic`, stateless, one shared `pg.Pool`), `mcp` (`sessionIdGenerator: undefined`, fresh server per request, no `Mcp-Session-Id`). **Must not:** `worker`. `migrate` is 0-or-1.

### 1.2 Why the worker is a singleton

1. **The checkpoint has no ownership token and no monotonic guard.** `saveCheckpoint()` (`packages/core/src/sync.ts`) is `replay_id = COALESCE(EXCLUDED.replay_id, cdc_checkpoints.replay_id)` — no `GREATEST`, no lease. Two consumers overwrite each other: a lagging one moves the checkpoint **backwards** (replay storm), a leading one moves it **past events its peer never applied** (silent loss). The poison-event block is per-process (`runner.blockedAt`), so worker A's block does not stop B consuming past the failed replay id A is holding.
2. **Single-flight is in memory.** `createControlApp()` keeps `let busy`; `runBulkExtract()` and `reconcile()` have no cross-process lock, so two workers run two concurrent Bulk API query jobs on the same objects.
3. `reapOrphanSyncRuns()` at startup closes *every* stale `kind='cdc'` `running` row, a peer's included.

The `pg_advisory_xact_lock(hashtext(lower(email)))` in `apps/web/lib/leads/dedupe.ts` is fine with replicas — it is transaction-scoped in the database. Only the CDC plane forbids scaling. **Restart:** `unless-stopped`, `stop_grace_period: 90s`, because shutdown is bounded but not instant: an in-flight apply may finish its budget (`APPLY_RETRY_DELAYS_MS = [250, 1_000, 3_000]`, about 4.25 s), then `stopConsumer()` cancels four streams, the `cdc` run closes, control closes, `closePool()` drains. Docker's default 10 s is too short. To scale it later, hold `pg_try_advisory_lock(914002)` for the process lifetime and exit non-zero when it is not acquired.

### 1.3 What 2+ web replicas break

The three buckets in `apps/web/lib/leads/rate-limit.ts` live in module scope, so `k` replicas give up to `k×` the limit, unevenly: per-IP 5/10 min becomes **up to 15**, the global 60/10 min up to 180, and per-email 2/10 min up to **6 — the abuse vector that bucket exists for**. An IP can also be blocked on one replica and accepted on another.

---
## 2. Image build

### 2.1 `next.config.mjs` — one line, and the workspace trap

```diff
 const nextConfig = {
   transpilePackages: ['@poc/core', '@poc/salesforce'],
   outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
+  output: 'standalone',
```

`outputFileTracingRoot` must stay: it is what makes `standalone` work in a pnpm workspace. Without it Next traces from `apps/web` and emits `standalone/apps/web/server.js` with unresolved `@poc/core` symlinks and no root `node_modules/.pnpm`, so the container dies with `Cannot find module '@poc/core'`. With the root pinned the trace emits a mirror (`standalone/apps/web/server.js`, `standalone/node_modules/.pnpm/…`, `standalone/apps/web/node_modules/@poc/core ->`, `standalone/packages/core/src/*.ts`), so the runtime copies the **mirror** and runs `node apps/web/server.js`.

### 2.2 `Dockerfile.prod`

```dockerfile
# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=10.8.0
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH CI=1 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/salesforce/package.json packages/salesforce/
COPY apps/web/package.json apps/web/
COPY apps/mcp/package.json apps/mcp/
COPY apps/worker/package.json apps/worker/
COPY apps/salesforce-mock/package.json apps/salesforce-mock/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN pnpm -r --if-present run typecheck && pnpm --filter @poc/web run build

FROM builder AS migrate          # keeps tsx + db/ + scripts/ for the migrate job
ENTRYPOINT ["/usr/local/bin/migrate.sh"]

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      dumb-init ca-certificates postgresql-client && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 TZ=UTC
WORKDIR /app
COPY docker/poc-entrypoint.sh docker/migrate.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/poc-entrypoint /usr/local/bin/migrate.sh
# PID 1 reaps zombies and forwards SIGTERM to one child; the shim exports
# /run/secrets/* then execs, so node is that child and receives the signal.
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/poc-entrypoint"]

FROM runtime AS web
# apps/web/public does not exist in this repo: add a .gitkeep or drop this line,
# because COPY of a missing path fails the build.
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

FROM runtime AS service
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps --chown=node:node /app/packages/salesforce/node_modules ./packages/salesforce/node_modules
COPY --from=deps --chown=node:node /app/apps/mcp/node_modules ./apps/mcp/node_modules
COPY --from=deps --chown=node:node /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --chown=node:node package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY --chown=node:node packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY --chown=node:node packages/core/src ./packages/core/src
COPY --chown=node:node packages/salesforce/package.json packages/salesforce/tsconfig.json ./packages/salesforce/
COPY --chown=node:node packages/salesforce/src packages/salesforce/proto ./packages/salesforce/
COPY --chown=node:node apps/mcp/package.json apps/mcp/tsconfig.json ./apps/mcp/
COPY --chown=node:node apps/mcp/src ./apps/mcp/src
COPY --chown=node:node apps/worker/package.json apps/worker/tsconfig.json ./apps/worker/
COPY --chown=node:node apps/worker/src ./apps/worker/src
USER node
EXPOSE 3001 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "const t=require('node:fs').readFileSync('/run/secrets/crm_api_token','utf8').trim();fetch('http://127.0.0.1:3002/health',{headers:{authorization:'Bearer '+t}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

Targets: `--target web`, `--target service`, `--target migrate`.

### 2.3 `docker/poc-entrypoint.sh`

Nothing in the app reads `/run/secrets`; only `process.env` counts.

```sh
#!/bin/sh
set -eu
for f in /run/secrets/*; do
  [ -f "$f" ] || continue
  export "$(basename "$f" | tr '[:lower:]' '[:upper:]')=$(tr -d '\n' < "$f")"
done
exec "$@"
```

Write secrets with `printf '%s' "$VALUE" > secrets/crm_api_token.txt`: a trailing newline inside `DATABASE_URL` reaches `pg` as `database "crm\n" does not exist`.

### 2.4 Why `web` is prod-deps-only and `service` is not (yet)

`web` ships exactly what Next traced — no `tsx`, no `typescript`, no `@types/*`. `mcp`/`worker` cannot, and pretending otherwise yields a container that crashes on boot: `packages/core` and `packages/salesforce` export **TypeScript sources** (`"." : "./src/index.ts"`), `apps/*` have no `build` script, and `tsx` is a **root devDependency**, so `pnpm install --prod` deletes it and `node_modules/.bin/tsx` is missing. So `service` copies the full lockfile-pinned `node_modules`. Fix (§10 row 14): `tsc -b` to `dist/`, `exports` to `./dist/*.js`, `start` to `node dist/index.js`, then `COPY --from=prod-deps`. Saves ~120 MB.

### 2.5 Why the dev image must never ship

The root `Dockerfile` is not a build: `CMD` is `node -e "console.log('poc container ready')"`, which prints and exits 0, so any `restart: unless-stopped` on it becomes an infinite restart loop the orchestrator reports as "restarting", not "broken". It also runs as **root**; sets `NODE_ENV=development` (React dev bundles, stack traces, no caching); never runs `next build` (per-request compile at ~10× CPU); and `COPY . .` picks up **`.env`**, because `.dockerignore` excludes `node_modules`, `.git`, `.next`, `docs`, `*.md`, `.pnpm-store`, `dist`, `.tmp` and **not** `.env*`, so real Salesforce credentials land in an image layer. Add `.env`, `.env.*`, `secrets`, `*.tsbuildinfo`, `.github`, `**/test`.

---
## 3. `docker-compose.prod.yml`

Validated: extracted to `/tmp` and passed `docker compose -f /tmp/extracted.prod.yml config -q` (exit 0) with `REGISTRY`/`IMAGE_TAG` set; without them it fails on `required variable REGISTRY is missing a value`, which is what `:?` is for. Pin the tag CI pushed, or the digest — never `latest`: `docker buildx imagetools inspect "$REGISTRY/poc-web:$IMAGE_TAG" --format '{{.Manifest.Digest}}'`.

```yaml
name: poc-crm-prod
x-logging: &logging { driver: json-file, options: { max-size: "10m", max-file: "5" } }
x-base: &base
  restart: unless-stopped
  init: true                     # tini → dumb-init → shim → node
  logging: *logging
  security_opt: [no-new-privileges:true]
  cap_drop: [ALL]
  read_only: true
  tmpfs: [/tmp:size=64m,mode=1777]
x-hc: &hc { interval: 15s, timeout: 5s, retries: 3, start_period: 30s }
x-roll: &roll
  update_config: { order: start-first, parallelism: 1, delay: 10s, failure_action: rollback }
  rollback_config: { order: stop-first }

services:
  web:
    <<: *base
    image: "${REGISTRY:?set REGISTRY}/poc-web:${IMAGE_TAG:?set IMAGE_TAG}"
    command: ["node", "apps/web/server.js"]
    env_file: [./env/web.env]
    environment: { NODE_ENV: production, PORT: "3000", HOSTNAME: 0.0.0.0, PG_POOL_MAX: "10" }
    secrets: [crm_api_token]
    healthcheck: { <<: *hc, test: [CMD, node, -e, "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"] }
    deploy: { <<: *roll, replicas: 3, resources: { limits: { cpus: "1.0", memory: 768M } } }
    stop_grace_period: 20s
  mcp:
    <<: *base
    image: "${REGISTRY:?set REGISTRY}/poc-service:${IMAGE_TAG:?set IMAGE_TAG}"
    command: ["node_modules/.bin/tsx", "apps/mcp/src/index.ts"]
    env_file: [./env/mcp.env]
    environment: { NODE_ENV: production, MCP_PORT: "3001", LOG_LEVEL: info }
    secrets: [mcp_auth_token, crm_api_token]
    healthcheck: { <<: *hc, test: [CMD, node, -e, "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"] }
    deploy: { <<: *roll, replicas: 2, resources: { limits: { cpus: "0.5", memory: 384M } } }
    stop_grace_period: 15s
  worker:
    <<: *base
    image: "${REGISTRY:?set REGISTRY}/poc-service:${IMAGE_TAG:?set IMAGE_TAG}"
    command: ["node_modules/.bin/tsx", "apps/worker/src/index.ts", "all"]
    env_file: [./env/worker.env]
    environment: { NODE_ENV: production, WORKER_MODE: all, PORT_CONTROL: "3002", PG_POOL_MAX: "10",
                   CDC_RUN_IDLE_CLOSE_MS: "30000", PUBSUB_NUM_REQUESTED: "100" }
    secrets: [crm_api_token]
    healthcheck: { <<: *hc, interval: 30s, start_period: 90s, test: [CMD, node, -e, "const t=require('node:fs').readFileSync('/run/secrets/crm_api_token','utf8').trim();fetch('http://127.0.0.1:3002/health',{headers:{authorization:'Bearer '+t}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"] }
    deploy: { replicas: 1, update_config: { order: stop-first, parallelism: 1 }, resources: { limits: { cpus: "1.0", memory: 1G } } }
    stop_grace_period: 90s       # >> 4.25 s apply budget + stream cancel + pool drain
  migrate:
    image: "${REGISTRY:?set REGISTRY}/poc-migrate:${IMAGE_TAG:?set IMAGE_TAG}"
    profiles: [tools]
    init: true
    restart: "no"
    logging: *logging
    entrypoint: ["/usr/local/bin/migrate.sh"]
    environment: { PGAPPNAME: poc-migrate, MIGRATION_LOCK_KEY: "914001" }
    secrets: [database_url]

networks:
  default: { name: poc-prod }
  edge:    { external: true, name: poc-edge }
secrets:
  crm_api_token: { file: ./secrets/crm_api_token.txt }
  mcp_auth_token: { file: ./secrets/mcp_auth_token.txt }
  database_url:  { file: ./secrets/database_url.txt }
```

- **No `postgres` service.** `DATABASE_URL` points at the managed instance. If a container is mandatory: pin by digest, no published port, `POSTGRES_PASSWORD_FILE`, a volume, tuned `max_connections`/`shared_buffers`, and a `wal-g`/pgBackRest sidecar with a restore drill. One container with a volume has no PITR and no failover; it is not a production database.
- **No published ports.** `POST /run/*` is reachable only inside `poc-prod` (operators use `docker compose exec` or `ssh -L 3002:worker:3002`); `web`/`mcp` sit only on the proxy network, because anyone who reaches `web:3000` directly forges `X-Forwarded-For` (§6).
- **`read_only` everywhere**; adding ISR later means a volume at `apps/web/.next/cache`, not `read_only: false`. **`logging` without `max-size`** fills the host disk. **`deploy.resources`** works in non-swarm compose; `mem_limit`/`cpus` are legacy spellings ignored in swarm.
- **Healthchecks** use what proves liveness: `web /api/health` (`SELECT 1`; 503 with the DB down), `mcp /health`, `worker /health` **with the bearer token**, because it is authenticated and a tokenless probe is a permanent 401 that keeps the container unhealthy. Do not probe `/api/crm/sync/status`. **Rotation** needs no rebuild: `printf '%s' new > secrets/crm_api_token.txt && docker compose up -d --no-deps web mcp`.

---
## 4. Migrations in production

### 4.1 `db/postgres-init.sh` is a first-boot convenience only

`/docker-entrypoint-initdb.d/*` runs **once, and only when `PGDATA` is empty**: never again on an existing volume, and not at all on a managed service. It also creates `poc_crm_test`, and it is why `down -v && up` is currently the "migration strategy". Dev only. `packages/core/scripts/migrate.ts` is better (sorted files, each one `client.query`, so a multi-statement file is one implicit transaction) but **has no lock** (replicas or a retried CI step race on the catalog) and **no version table**. It also applies to `TEST_DATABASE_URL` when set, so leave that unset.

### 4.2 The real flow: one locked, forward-only step

`docker/migrate.sh`. Lock, bookkeeping and DDL run in **one psql session**, so the session-level advisory lock covers the run and `--single-transaction` makes it atomic:

```sh
#!/bin/sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
LOCK_KEY=${MIGRATION_LOCK_KEY:-914001}
case "$LOCK_KEY" in (*[!0-9]*) echo "LOCK_KEY must be numeric" >&2; exit 2;; esac
{
  echo "\\set ON_ERROR_STOP on"
  echo "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY,"
  echo "  checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());"
  echo "SELECT pg_advisory_lock($LOCK_KEY);"
  for f in db/migrations/*.sql; do
    [ -f "$f" ] || continue
    v=$(basename "$f"); c=$(sha256sum "$f" | cut -d' ' -f1)
    echo "SELECT COALESCE((SELECT checksum FROM schema_migrations WHERE version='$v') = '$c', false) AS skip \\gset"
    echo "\\if :skip"; echo "  \\echo 'skip $v'"; echo "\\else"
    echo "  \\echo 'apply $v'"; echo "  \\i $f"
    echo "  INSERT INTO schema_migrations (version, checksum) VALUES ('$v','$c')"
    echo "    ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now();"
    echo "\\endif"
  done
} > /tmp/apply.sql
psql "$DATABASE_URL" --single-transaction -f /tmp/apply.sql
```

Re-runs are no-ops. A concurrent run blocks on `pg_advisory_lock` until the first disconnects, then sees every checksum recorded and applies nothing. `ON_ERROR_STOP` turns the first error into a non-zero exit **before** `COMMIT`, so a half-applied schema is impossible. Release step:

```sh
docker compose -f docker-compose.prod.yml --profile tools run --rm migrate
# CI: docker run --rm -e DATABASE_URL="$DATABASE_URL" -v "$PWD/db:/app/db:ro" "$REGISTRY/poc-migrate:$IMAGE_TAG"
```

`pnpm migrate` stays for local convenience. Do not run it in prod.

### 4.3 Expand, then contract

A rolling deploy runs both versions at once, so no migration may require them to change together: **expand** (nullable `ADD COLUMN` with a constant default, which is metadata-only in PG 11+, new tables, `CREATE INDEX CONCURRENTLY` in its own file because it cannot run in a transaction, `ADD CONSTRAINT … NOT VALID`), then **backfill + deploy** code that writes both shapes, then **contract** one release later. Example (soft delete, §10 row 5): `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;` then separately `CREATE INDEX CONCURRENTLY accounts_live_idx ON accounts (lower(name)) WHERE deleted_at IS NULL;`

### 4.4 Rollback

Forward-only; no down-migrations, because one that drops a column destroys what the rollback protects. *App rollback* is the normal case: redeploy the previous `IMAGE_TAG`, safe by construction if every release was expand-then-contract. *Schema rollback* (bad destructive step only): PITR to a **new** instance at `T - Δ`, verify, repoint `DATABASE_URL`, and never restore over the live instance. Keep `schema_migrations.checksum`: a changed file for an applied version is drift and must fail hard.

---
## 5. Configuration and secrets

Every variable the code reads (`grep -rn 'process.env\.' apps packages`, non-test). "Fails" is observed behaviour, not a wish.

| Variable | Secret | Production shape | Missing / wrong → fails how |
|---|---|---|---|
| `DATABASE_URL` | **yes** | `postgres://crm_app:REPLACE_ME@db.REPLACE_ME.internal:5432/crm?sslmode=verify-full&sslrootcert=/etc/ssl/certs/ca.pem&application_name=web&options=-c%20statement_timeout%3D15000` | `getPool()` throws `DATABASE_URL is not set`; `/api/health` returns `503 {"status":"degraded","db":"down"}`; worker dies at first query. `sslmode=require` accepts any certificate, so use `verify-full` |
| `PG_POOL_MAX` / `TEST_DATABASE_URL` | no | `10` per process (§7.1) / **unset** | default `10`; a set `TEST_DATABASE_URL` makes `pnpm migrate` target a test database that will not exist |
| `CRM_API_TOKEN` | **yes** | ≥32 random bytes, one per client (§10 row 1) | fails closed but **not with 401**: `requireCrmToken()` throws `AppError('internal', …)`, so the answer is HTTP **500** with a generic body plus `[crm-api] CRM_API_TOKEN is not configured; rejecting every request`. On the worker `expected === ''` gives **401 on every control route, including `/health`** |
| `CRM_API_BASE_URL` | no | `http://web:3000` (internal DNS, never the public host) | defaults to `http://localhost:3000`, so every MCP tool call fails with connection refused |
| `MCP_AUTH_TOKEN` | **yes** | distinct from `CRM_API_TOKEN`, one per MCP client | `createAuthMiddleware('')` gives **401 on every `/mcp`** (fail closed); `/health` stays open |
| `MCP_PORT` / `LOG_LEVEL` / `PORT_CONTROL` | no | `3001` / `info` / `3002` (internal only) | defaults |
| `SF_USE_MOCK` | no | **`false`** | **default is `true`**: OAuth to `http://salesforce-mock:4000` (DNS fail) and `credentials.createInsecure()` against an unresolvable name, so a reconnect loop every 1–30 s forever. Half-migrated (`true` with a real `PUBSUB_ENDPOINT`) sends **plaintext** gRPC at TLS port 7443 |
| `SF_LOGIN_URL` / `SF_INSTANCE_URL` | no | `https://login.salesforce.com` / `https://REPLACE_ME.my.salesforce.com` | CDC `authMetadata()` omits `instanceurl` |
| `SF_TENANT_ID` | no | 18-char org id | metadata omits `tenantid`, so a real org rejects `Subscribe` |
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | secret for the pair | External Client App key/secret, scopes `api` and `pub/sub_api` only | `SalesforceAuthError` from the token endpoint |
| `SF_USERNAME` / `SF_PASSWORD` / `SF_SECURITY_TOKEN` | **yes** | all unset unless using the password grant | the password grant is chosen only when **not** mock **and** username **and** password are set |
| `PUBSUB_ENDPOINT` | no | `api.pubsub.salesforce.com:7443` | falls back to `salesforce-mock:50051` when mocking |
| `PUBSUB_TOPIC` + `_OPPORTUNITY`/`_CONTACT`/`_LEAD` | no | `/data/*ChangeEvent` | `defaultTopics()` **merges** them with four hard-coded defaults, so a typo *adds* a bogus subscription that fails forever and you cannot select a subset; use `PUBSUB_TOPICS` |
| `PUBSUB_TOPICS` / `PUBSUB_NUM_REQUESTED` / `PUBSUB_MIN_BACKOFF_MS` / `CDC_RUN_IDLE_CLOSE_MS` | no | comma list / `100` (broker cap) / `1000` / `30000` | defaults |
| `WORKER_MODE` / `WORKER_FORCE_BULK` / `WORKER_BULK_SKIP_WINDOW_MS` / `WORKER_CDC_JSON` | no | `all` / unset / `600000` / `1` for JSON events | defaults; `all` skips a bulk run younger than 10 min |
| `SF_API_VERSION` / `SF_TOKEN_TTL_MS` / `SF_HTTP_TIMEOUT_MS` / `PUBSUB_MAX_BACKOFF_MS` | no | `v62.0` / `1200000` / `60000` / `30000` | defaults |
| `PUBSUB_REPLAY_PRESET` / `MOCK_*` / `SF_MOCK_*` / `E2E_*` | — | **must not exist in prod** | `PUBSUB_REPLAY_PRESET` is dead: **nothing reads it** and the preset is derived from the stored checkpoint (`CUSTOM` once a replay id exists). The rest are dev/test only |

### 5.1 Real Salesforce OAuth

Use an **External Client App** (not a Connected App): consumer key to `SF_CLIENT_ID`, secret to `SF_CLIENT_SECRET`, **Client Credentials Flow** enabled, a run-as user that is read-only plus Bulk API and Pub/Sub API permissions, and no callback URL. Client-credentials is the right grant for a server-to-server sync, so leave `SF_USERNAME`/`SF_PASSWORD` unset and `auth.ts` picks it. The password grant (with `SF_SECURITY_TOKEN` appended) is acceptable only for a short staging check: it breaks on rotation and on MFA-enforced orgs. Tokens are cached for `SF_TOKEN_TTL_MS` and refreshed exactly once on a 401 (`http.ts`); gRPC metadata is read per subscribe, so a token expiring mid-stream costs one reconnect, which is normal. `SF_USE_MOCK=false` has never run against a real org (`FINDINGS.md` §2): one `worker once` against a sandbox, reviewed by hand, is a task with an owner, not a config change.

---
## 6. Reverse proxy and TLS

```caddyfile
{
  email ops@REPLACE_ME.example
  servers { trusted_proxies static private_ranges }
}
crm.example.com {
  encode zstd gzip
  log { output stdout
        format json }
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    -Server
  }
  reverse_proxy web:3000 {
    # MUST be set, and must OVERWRITE (not append) a client-supplied header:
    # rate-limit.ts takes forwarded.split(',')[0] — the left-most entry.
    header_up X-Forwarded-For {remote_host}
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-Proto {scheme}
    health_uri /api/health
    health_interval 15s
    lb_policy least_conn
  }
}
mcp.example.com {
  reverse_proxy mcp:3001 {
    header_up X-Forwarded-For {remote_host}
    flush_interval -1          # Streamable HTTP: never buffer the response
  }
}
```

**Why `X-Forwarded-For` must be set — and overwritten.** `clientIpFromHeaders()` takes the **first** element. Behind an appending proxy a client sends `X-Forwarded-For: 203.0.113.7` and the app sentences *that* address: the per-IP bucket is bypassed with a header while the victim gets blocked. Behind no proxy every request carries the Docker bridge address (`172.x`), `isAttributableIp()` returns false, and everything lands in the **global 60-per-10-min bucket**, one shared bucket for the whole internet. The code tells you which happened:

```
[leads] submission outcome=created status=201 bucket=ip ip=203.0.113.7 email_sha256=4f2c9a1b77de lead_id=8f14e45f-…
```

`bucket=global` on real traffic means the proxy is missing or misconfigured. And XFF alone is not enough, because anyone who can reach `web:3000` forges it; hence no published ports (§3).

**SSE / Streamable HTTP.** `POST /mcp` can answer `text/event-stream`, and a buffering proxy holds the body until the tool call ends while a 60 s read timeout cuts long calls. Caddy's `flush_interval -1` disables buffering. nginx needs `proxy_buffering off; proxy_http_version 1.1; chunked_transfer_encoding on; proxy_read_timeout 3600s; proxy_set_header X-Accel-Buffering no;`. Traefik needs `responseForwarding.flushInterval=-1` plus a `ServersTransport` with `responseHeaderTimeout=0`. Do not put the MCP host behind a default-config proxy and then debug "the agent hangs"; it is buffering every time. The POC is stateless (`GET /mcp` answers 405), so 600 s suffices today, but keep the setting anyway.

---
## 7. Postgres in production

### 7.1 Connections

`packages/core/src/db.ts` builds **one `pg.Pool` per process**: `max: PG_POOL_MAX ?? 10`, `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 10_000`.

```
web 3 × 10 = 30  +  worker 1 × 10 = 10  +  mcp 0 (HTTP only, never pg)  +  migrate 1  ≈ 41
```

Against `max_connections=100` minus reserved slots that leaves ~59 for admin, backup and monitoring, which is fine but a coincidence of this arithmetic, so write the formula into `env/*.env` beside `PG_POOL_MAX`: the effective count is the product of a code default, an env value and a replica count, and nobody computes it during an incident. As `replicas × PG_POOL_MAX` approaches the limit, use PgBouncer in transaction mode and **lower** `PG_POOL_MAX` to 2–4, because pooling twice is worse than not pooling. Add `application_name` per service and a `statement_timeout` (15 s web, 300 s worker, none for migrate).

### 7.2 Backups and a restore drill

PITR on, WAL archived continuously, at least 7 days of WAL plus 30 days of daily base backups, encrypted at rest, TLS in transit. Run a **restore drill** monthly or in CI: restore yesterday to a scratch instance, run the migrate step (it must be a no-op), run `reconcile`, destroy. A backup never restored is a hypothesis, and this schema has FKs (`contacts.account_id`, `opportunities.account_id`) with a restore order to get right. `cdc_events.payload` holds full records, which is personal data in `jsonb` with no erasure path (`FINDINGS.md` §4 row 9).

### 7.3 Settings and indexes

`pgcrypto` (already in `001`), `pg_stat_statements` (`max=10000`, `track=all`), `pg_cron` for §7.4; sort `pg_stat_statements` by `mean_exec_time * calls` and read the top 20, which is the whole query surface. Indexes that matter: the unique `salesforce_id` on all four tables (every CDC upsert resolves on it), `cdc_events.event_id` UNIQUE (the dedupe key the at-least-once model rests on), the `lower(...)` search indexes, `leads_created_at_idx`, `cdc_events_channel_idx (channel, replay_id DESC)` for the replay and block queries, and `sync_runs_started_idx`. **Add** a partial index for the block query, which runs on every subscribe and would otherwise seq-scan at 10 M rows:

```sql
CREATE INDEX CONCURRENTLY cdc_events_failed_idx
  ON cdc_events (channel, replay_id) WHERE status = 'failed';
```

### 7.4 `cdc_events` growth and retention

One row per event with the full record as `jsonb`, and nothing prunes it, so `getSyncStatus()`'s `count(*)` and `max(...)`, which is the dashboard card, degrade daily. Batched retention, never one long `DELETE`:

```sql
WITH doomed AS (
  SELECT e.id FROM cdc_events e
   WHERE e.status IN ('applied', 'skipped_stale', 'ignored')  -- never 'failed': it IS the block
     AND e.received_at < now() - interval '30 days'            -- never 'pending': in flight
     AND (e.replay_id IS NULL OR e.replay_id < COALESCE(
           (SELECT c.replay_id FROM cdc_checkpoints c WHERE c.channel = e.channel), e.replay_id))
   ORDER BY e.received_at LIMIT 50000
)
DELETE FROM cdc_events e USING doomed d WHERE e.id = d.id RETURNING e.id;
```

Loop until 0 rows, then `VACUUM (ANALYZE) cdc_events`, and log the per-run count. The `replay_id < checkpoint` clause stops the job deleting the evidence of a long block, which would clear an incident by removing its proof.

**Why 30 days and not 3.** Pub/Sub retains events for **72 hours**, and this table is what makes a within-window replay idempotent: the two windows are one contract. Prune below 72 h and a replay (after a long outage, or a checkpoint restored from an older backup) re-delivers events whose `event_id` is no longer recorded. The `salesforce_updated_at` guard makes most of it a no-op, but `DELETE`/`UNDELETE` can re-apply out of order, and the CDC delete path still passes no timestamp (`FINDINGS.md` §3 P1-2), so an old `DELETE` can remove a newer row. You also lose the audit trail behind redrive/discard decisions. **Retention of at least 72 h plus margin**; 30 days is the recommendation and anything under 72 h is a data bug, not a storage decision. At 10 M rows, switch to monthly `PARTITION BY RANGE (received_at)` and `DROP PARTITION` (the unique key then includes `received_at`). The consequence for the operator is that **you cannot replay beyond the shorter window**: a topic blocked longer than 72 h has an event the broker will never re-deliver, and the only exits are `POST /run/redrive` on the stored payload (which still works) or a full bulk re-extract, which is why §8.3 alerts on checkpoint age.

---
## 8. Observability

### 8.1 Logs you already have — ship them

stdout/stderr only; nothing writes files. `web` lead submissions, one line, all fields, never the raw email:

```
[leads] submission outcome=rate_limited status=429 bucket=global ip=unknown email_sha256=4f2c9a1b77de lead_id=-
```

`worker`/CDC (`packages/salesforce/src/cdc.ts`), the four that carry operational meaning:

```
[cdc] consumer started topics=4 endpoint=api.pubsub.salesforce.com:7443 mode=real
[cdc] Account UPDATE 001MOCK000000001 replay=1795653255416180 latency=23 outcome=applied
[cdc][ALERT] topic=/data/OpportunityChangeEvent replay=… event=…:… Opportunity UPDATE 006… apply failed after 3 attempts; checkpoint NOT advanced (blocked). Fix or redrive. last_error=…
[cdc] /data/OpportunityChangeEvent unblocked (no failed events remain at replay=…), resuming
```

`mcp` (`apps/mcp/src/logger.ts`), one JSON object per line, argument **keys** only and never lead payloads:

```json
{"ts":"2025-11-25T21:43:02.114Z","level":"info","service":"mcp","msg":"mcp.request","rpc_method":"tools/call","tool":"list_leads","arg_keys":["status"],"status":200,"duration_ms":41,"outcome":"ok"}
```

Alert on `outcome=failed` and `[cdc][ALERT]`, not on prose, so keep the format. `mcp.auth.rejected` carries `reason=missing_token|invalid_token`, which is the rotation alarm. Ship with a collector sidecar (Vector/Fluent Bit) on the json-file driver and set PII rules on the sink: `ip` is arguably PII, and `cdc_events.payload` never reaches logs because it is in the database, which is worse (§7.2).

### 8.2 Probes

| Endpoint | Proves | Use as |
|---|---|---|
| `GET /api/health` (web) | process up **and** `SELECT 1` works; **503** with the DB down | readiness (+ liveness if you accept a DB blip restarting replicas) |
| `GET /health` (mcp) | up; also calls `crm.ping()` | liveness **only**, because chaining readiness takes the MCP fleet out on an API blip. `FINDINGS.md` §3 P2-5: unauthenticated and leaks upstream health; make `upstream` static |
| `GET /health` (worker :3002) | control loop alive; falls back to the last persisted `sync_runs` row | liveness, **with `Authorization: Bearer $CRM_API_TOKEN`** |

On `FINDINGS.md` §3 P1-6 ("worker has no healthcheck", open at `33559d4`): the current `docker-compose.yml` does have one, probing `:3002/health` with the token, so §3 keeps it rather than adding it. The `restart: "no"` half of that finding is still true, and `unless-stopped` fixes it.

### 8.3 Four metrics, and where they already live

| Metric | Source | Derivation | Alert |
|---|---|---|---|
| **CDC lag** | `cdc_checkpoints.last_event_at`, `max(processed_at)`; already `lagSeconds` in `getSyncStatus()` → `GET /api/crm/sync/status` | `now() - last_event_at` per channel | >120 s for 5 min (warn), >900 s (page) |
| **Failed events** | `cdc_events.status='failed'` → `counts.failedEvents`; checkpoint `error='blocked by N failed event(s), oldest replay …'` | `SELECT channel, count(*) … GROUP BY 1` | **any** row older than 5 min → page |
| **Blocked channels** | checkpoint `status='error'`; `sync_runs.details->>'blocked'` on the live `cdc` run | `count(*) FILTER (WHERE status='error')` | >0 for 10 min → page |
| **Bulk duration** | `sync_runs` (`kind='bulk_extract'`, `details.duration_ms`, `records_read/_written`, `error`), control-plane `lastBulkRun` | last 20 runs | >2× 7-day p50, `failed`, or `totals.errors > 0` |

Also emit `sync_runs` `running` older than 15 min (the bulk half of P1-3 is still open, and a killed bulk run stays `running` forever), pool occupancy, and proxy `http_requests_total{status}`. Alert list: (1) `cdc_events.status='failed'` older than 5 min → page; (2) checkpoint `status='error'` for 10 min → page; (3) lag as above; (4) stale `running` bulk run → warn; (5) `web` 5xx over 1 % for 5 min → page, and **this is where the `CRM_API_TOKEN`-unset 500 loop appears**, so check `[crm-api] CRM_API_TOKEN is not configured` first; (6) `mcp.auth.rejected` over 20/min → warn; (7) `[leads] … bucket=global` share over 10 % → warn.

---
## 9. Operations runbook

**Deploy**: three images, one tag, never `latest`; migrate; then roll.

```sh
export REGISTRY=REPLACE_ME IMAGE_TAG=1.4.0
docker build -f Dockerfile.prod --target web     -t "$REGISTRY/poc-web:$IMAGE_TAG" .
docker build -f Dockerfile.prod --target service -t "$REGISTRY/poc-service:$IMAGE_TAG" .
docker build -f Dockerfile.prod --target migrate -t "$REGISTRY/poc-migrate:$IMAGE_TAG" .
docker push "$REGISTRY/poc-web:$IMAGE_TAG"; docker push "$REGISTRY/poc-service:$IMAGE_TAG"; docker push "$REGISTRY/poc-migrate:$IMAGE_TAG"
docker compose -f docker-compose.prod.yml --profile tools run --rm migrate   # §4.2, locked
docker compose -f docker-compose.prod.yml up -d --no-deps web mcp            # start-first
docker compose -f docker-compose.prod.yml up -d --no-deps worker             # stop-first
```

**Rollback**: redeploy the previous tag (`IMAGE_TAG=1.3.9 docker compose -f docker-compose.prod.yml up -d`), and the schema is unchanged by design (§4.3). For a destructive release, PITR to a new instance, verify, repoint `DATABASE_URL` (§4.4). **Scale web**: `docker compose -f docker-compose.prod.yml up -d --scale web=5 --no-recreate`, but not before §10 row 2 or you are scaling the bypass in §1.3.

**Restart the worker safely.**

```sh
docker compose -f docker-compose.prod.yml kill -s TERM worker   # then 90 s grace
docker compose -f docker-compose.prod.yml logs --tail=200 worker | grep -E '\[cdc\]|\[worker\]'
```

The checkpoint is written **after** the row is applied, so a kill between `applySalesforceRecord` and `saveCheckpoint` re-delivers the event, `recordCdcEvent` returns `duplicate: true` on the unique `event_id`, and the consumer skips **and advances**. That is why it can be killed at any instant without losing or double-writing a row. What does not survive: the in-memory block (`runner.blockedAt`, re-derived from `status='failed'` rows on the next subscribe, so a restart cannot launder an incident); the in-process retry budget (a mid-retry event restarts its three attempts); the live `cdc` `sync_runs` row (left `running` until the next startup's `reapOrphanSyncRuns()` closes it as `failed`/`orphaned`); and a half-finished **bulk** run, which stays `running` forever (P1-3 residue), so clean it up with `UPDATE sync_runs SET status='failed', finished_at=now(), error='abandoned by operator restart' WHERE kind='bulk_extract' AND status='running' AND started_at < now() - interval '20 minutes';`

**Drain / inspect**: checkpoints and `cdc_events` are the queue, so there is no broker to drain.

```sh
curl -s -H "authorization: Bearer $CRM_API_TOKEN" https://crm.example.com/api/crm/sync/status \
  | jq '{lagSeconds, counts, checkpoints: [.checkpoints[] | {channel, status, replay_id, error}]}'
```

**Redrive vs discard**: both deliberately need an operator.

```sh
curl -s -H "authorization: Bearer $CRM_API_TOKEN" \
  'https://crm.example.com/api/crm/sync/events?status=failed&limit=20' | jq '.data[] | {event_id, error}'
# fix the data or the mapper, then (still_failing > 0 means it is not fixed yet):
curl -s -X POST -H "authorization: Bearer $CRM_API_TOKEN" http://127.0.0.1:3002/run/redrive \
  -H 'content-type: application/json' -d '{"limit":50}' | jq
# only when the payload can never apply, and this abandons the change:
curl -s -X POST -H "authorization: Bearer $CRM_API_TOKEN" http://127.0.0.1:3002/run/discard \
  -H 'content-type: application/json' -d '{"event_ids":["<channel>:<replayId>"]}' | jq
```

Record who, which ids and why in the incident: `FINDINGS.md` §4 row 1 asks for an approver and an audit record, and today anyone with `CRM_API_TOKEN` can abandon data.

**"Salesforce is down"**: separate the planes. *Bulk* fails at the first REST call, so `sync_runs.status='failed'`; the worker logs `bulk extract failed — CDC consumer still starts` and keeps consuming, so re-run `POST /run/bulk` later (it is idempotent). An OAuth failure means checking the External Client App (scopes, run-as user, IP ranges) before blaming the network. *CDC* reconnects with 1 s to 30 s backoff from the persisted checkpoint, and **the clock is the 72-hour retention window** (§7.4): under 72 h nothing is lost, and over 72 h the events are gone at the broker so the only recovery is a full `POST /run/bulk` plus a documented, acknowledged gap. If *Postgres* is down instead, `/api/health` returns 503 and CDC apply retries 3×, dead-letters and blocks that topic; it is visible, and it self-heals on redrive once the database accepts writes. Do not restart the worker to "clear" it, because a database-derived block survives restarts.

---
## 10. Hardening checklist

Ordered by damage, matching `FINDINGS.md` §4. **P0** = data loss or full compromise, **P1** = production incident, **P2** = operational debt.

| # | POC shortcut | Production requirement | Sev | File that changes |
|---|---|---|---|---|
| 1 | One shared `CRM_API_TOKEN` for API, MCP and the control plane; no user identity | Per-client tokens with scopes, or OIDC to an IdP; `POST /run/discard` behind a named approver + immutable audit row; MCP→API on the private network or mTLS | **P0** | `apps/web/lib/api/auth.ts`, `apps/mcp/src/auth.ts`, `apps/worker/src/control.ts` |
| 2 | Rate limiting in process memory, resets on deploy, `N×` with replicas | Redis (or edge) sliding window, same three buckets/keys (`ip \| email_sha256 \| global`) + a durable submission record | **P0** (§1.3) | `apps/web/lib/leads/rate-limit.ts` |
| 3 | `SF_USE_MOCK` defaults to **true**; the mock ships in the repo | Mock absent from prod images; `SF_USE_MOCK=false` asserted at boot (fail fast, not reconnect-loop); real External Client App verified in staging | **P0** | `packages/salesforce/src/config.ts`, `apps/worker/src/index.ts` |
| 4 | `POST /run/*` control plane on `0.0.0.0:3002`, published by dev compose | Never published; internal network only; separate token; authz per route; append-only audit of bulk/reconcile/redrive/discard | **P0** | `apps/worker/src/control.ts` |
| 5 | CDC `DELETE` hard-deletes, and **both** CDC callers pass no timestamp, so an out-of-order DELETE removes a newer row | Soft delete with a tombstone (`deleted_at`, change type) and thread `header.commitTimestamp` through both call sites | **P0** | `packages/salesforce/src/cdc.ts:976`, `redrive.ts:99`, `packages/core/src/ingest.ts` |
| 6 | No auth on `/mock/*` (loopback only today) | The mock does not exist in production; a staging mock gets auth and its own network | **P0** | `apps/salesforce-mock/` (excluded from prod targets) |
| 7 | `worker` singleton with per-process single-flight and a non-monotonic checkpoint | Leader election (`pg_try_advisory_lock`) or a real queue/outbox with `FOR UPDATE SKIP LOCKED`; guard `saveCheckpoint` with `WHERE replay_id < EXCLUDED.replay_id` | **P1** | `packages/salesforce/src/cdc.ts`, `packages/core/src/sync.ts` |
| 8 | A blocked topic resolves only via a log line and a manual curl; no retry counter, no escalation | Alert on `failed > 0`; an `attempts` column on `cdc_events`; paging rotation; an approvals record for discard | **P1** | `cdc.ts`, `sync.ts` |
| 9 | `applySalesforceBatch` issues one statement per row (`ingest.ts:618`) | Batched multi-row `COPY`/`UPSERT` with the same stale guard; per-object concurrency limit; a `SystemModstamp` high-water mark so a re-run reads the delta, not the world | **P1** at 10 M rows | `packages/core/src/ingest.ts`, `packages/salesforce/src/bulk.ts` |
| 10 | Migrations: one idempotent file, no lock, no version table, applied by an `initdb` hook | §4.2 locked runner + `schema_migrations`; forward-only; expand-then-contract; `CONCURRENTLY` indexes; schema-diff check in CI | **P1** | `db/migrations/`, `packages/core/scripts/migrate.ts`, new `docker/migrate.sh` |
| 11 | No FLS / record-level model: one token, full read/write, no user | Map profiles/permission sets to RBAC; enforce field visibility in the API layer; an export decision per field | **P1** | `apps/web/lib/api/auth.ts`, all `apps/web/app/api/crm/**` |
| 12 | `cdc_events.payload` keeps full records forever; `count(*)` on a growing table | Retention/partitioning (§7.4), PII classification, an erasure path that reaches payload copies | **P1** | migrations + retention job |
| 13 | No metrics, no traces; latency computed on read | §8.3 metrics; OTel spans on the API and the CDC apply | **P1** | `apps/web/app/api/crm/sync/status/route.ts`, `apps/worker/src/control.ts` |
| 14 | No build for `mcp`/`worker`; `tsx` (a devDependency) ships to prod (§2.4) | `tsc` emit + `exports` to `dist`, `node dist/index.js`, prod-deps-only runtime | **P2** | all four `package.json` |
| 15 | `mcp` `/health` probes the CRM upstream unauthenticated (P2-5); `restart: "no"`; no readiness gate `mcp`→`web` | Static health field; `unless-stopped` + healthchecks + `service_healthy` + start-first rollouts | **P2** (deploy half fixed by §3) | `apps/mcp/src/index.ts`, `Dockerfile.prod`, `docker-compose.prod.yml` |
| 16 | `.dockerignore` excludes neither `.env*` nor `secrets/` | Exclude both; review it beside `Dockerfile.prod` | **P2** (P0 if an image was pushed) | `.dockerignore` |

---
## 11. CI/CD sketch

`.github/workflows/release.yml`. The gate is `pnpm typecheck && pnpm test`, the same commands as locally so green CI means a green laptop; then build → migrate → deploy → smoke.

```yaml
name: release
on:
  push: { branches: [main], tags: ["v*"] }
  pull_request:
concurrency: { group: "release-${{ github.ref }}", cancel-in-progress: true }
env:
  REGISTRY: ${{ secrets.REGISTRY }}      # REPLACE_ME, never hard-coded
  IMAGE_TAG: ${{ github.sha }}

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_USER: poc, POSTGRES_PASSWORD: poc, POSTGRES_DB: poc_crm }
        ports: ["5432:5432"]
        options: --health-cmd "pg_isready -U poc -d poc_crm" --health-interval 3s --health-retries 20
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10.8.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck                                  # GATE 1
      - run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_init.sql
      # The suite needs Postgres AND the mock, and it owns the stack while it runs
      # (FINDINGS.md §3 P2-3): serialise it, never run two concurrently.
      - run: pnpm --filter @poc/salesforce-mock run dev & sleep 5; pnpm test   # GATE 2
        env:
          DATABASE_URL: postgres://poc:poc@localhost:5432/poc_crm
          TEST_DATABASE_URL: postgres://poc:poc@localhost:5432/poc_crm_test
          CRM_API_TOKEN: ci-local-token
          SF_USE_MOCK: "true"
          SF_LOGIN_URL: http://localhost:4000
          PUBSUB_ENDPOINT: localhost:50051
          E2E_WEB_URL: http://localhost:3000
          E2E_MCP_URL: http://localhost:3001
          E2E_WORKER_CONTROL_URL: http://localhost:3002

  release:
    needs: verify
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    environment: production                 # required reviewers live here
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: "${{ env.REGISTRY }}", username: "${{ secrets.REGISTRY_USER }}", password: "${{ secrets.REGISTRY_TOKEN }}" }
      - uses: docker/build-push-action@v6
        with: { file: Dockerfile.prod, target: web, push: true, cache-from: "type=gha",
                cache-to: "type=gha,mode=max", tags: "${{ env.REGISTRY }}/poc-web:${{ env.IMAGE_TAG }}" }
        # repeat for target: service and target: migrate
      - uses: aquasecurity/trivy-action@0.28.0
        with: { image-ref: "${{ env.REGISTRY }}/poc-web:${{ env.IMAGE_TAG }}", exit-code: "1", severity: "CRITICAL" }
      - name: migrate (locked, single transaction)
        run: docker run --rm -e DATABASE_URL="$DATABASE_URL" -v "$PWD/db:/app/db:ro" "$REGISTRY/poc-migrate:$IMAGE_TAG"
        env: { DATABASE_URL: "${{ secrets.PROD_DATABASE_URL }}" }
      - name: deploy + smoke
        run: |
          docker compose -f docker-compose.prod.yml up -d --no-deps web mcp    # start-first
          docker compose -f docker-compose.prod.yml up -d --no-deps worker     # stop-first
          curl -fsS https://crm.example.com/api/health
          curl -fsS -o /dev/null -w '%{http_code}' https://mcp.example.com/health
```

**Staging e2e after deploy**: run the same suite with `E2E_*` pointed at staging (`apps/web/test/e2e/helpers.ts` reads them and falls back to compose service names), and never concurrently with another run, because it deletes and re-seeds Salesforce rows while it asserts. The one check no fixture substitutes for is `worker once` against a Salesforce **sandbox** with `SF_USE_MOCK=false`; gate the first production deploy on it manually and record the result.
