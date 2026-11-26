FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=1
RUN corepack enable && corepack prepare pnpm@10.8.0 --activate
WORKDIR /app

# --- dependencies (cached on lockfile/package.json changes) -----------------
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/salesforce/package.json packages/salesforce/
COPY apps/web/package.json apps/web/
COPY apps/mcp/package.json apps/mcp/
COPY apps/worker/package.json apps/worker/
COPY apps/salesforce-mock/package.json apps/salesforce-mock/
# Frozen: the lockfile is committed, so a rebuild cannot silently resolve new
# versions. Refresh it on purpose with:
#   docker compose run --rm --entrypoint sh tools -c 'pnpm install --lockfile-only'
RUN pnpm install --frozen-lockfile

# --- runtime ---------------------------------------------------------------
FROM deps AS runtime
COPY . .
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
CMD ["node", "-e", "console.log('poc container ready')"]
