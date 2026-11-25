# POC — Salesforce Migration, CDC & AI-Ready CRM with MCP

Technical proof of concept: a small internal CRM that replaces Salesforce gradually — importing records via **Bulk API 2.0**, staying in sync via **CDC (Pub/Sub API)**, capturing leads from a **public landing page**, and exposing CRM operations to **AI agents through MCP**.

> Not production-ready. The goal is technical validation, integration reliability and demonstrable business workflows.

📋 **Full checklist:** [`docs/POC-CHECKLIST.md`](docs/POC-CHECKLIST.md)

---

## Capabilities under validation

| # | Capability | Mechanism |
|---|---|---|
| 1 | Data migration | Salesforce Bulk API 2.0 → PostgreSQL |
| 2 | Real-time sync | Salesforce CDC → Pub/Sub API consumer |
| 3 | Internal CRM | Next.js (App Router) + Tailwind + TypeScript |
| 4 | Lead capture | Public `/lead` page → `POST /api/leads` → PostgreSQL |
| 5 | AI integration | MCP server (Streamable HTTP) → internal CRM API |

## Target architecture

```text
                   SALESFORCE
                       |
             +---------+---------+
             |                   |
         Bulk API             CDC Events
             |                   |
             +---------+---------+
                       |
                Node.js Worker
                       |
                       v
                   PostgreSQL
                       ^
                       |
          +------------+------------+
          |                         |
    Public Lead Page           Next.js CRM
      /lead                       /crm
          |                         |
          +------------+------------+
                       |
                 Internal API
                       |
                  MCP Server
                       |
                    AI Agents
```

Key design rules:

- All CRM consumers (UI, API, MCP) share **one business logic layer**.
- Salesforce integration code stays **isolated** from internal CRM operations.
- Salesforce-synced records and locally-captured leads are **clearly distinguishable** (`source` / `external_id`).
- For this POC, **Salesforce remains authoritative** for imported records.

## Technology stack

| Component | Technology |
|---|---|
| Frontend | Next.js (App Router) |
| UI | Tailwind CSS |
| Language | TypeScript |
| Backend | Node.js |
| Database | PostgreSQL |
| Salesforce | Bulk API 2.0 + Pub/Sub API |
| AI integration | MCP TypeScript SDK |
| Infrastructure | Docker Compose |
| Testing | Vitest |

## Status

Nothing implemented yet — the repository is scaffolded and the checklist in
[`docs/POC-CHECKLIST.md`](docs/POC-CHECKLIST.md) is the working plan.

## Planned layout

```text
apps/web            Next.js app: /crm, /lead, /api/*
apps/worker         Salesforce Bulk API extract + CDC consumer
apps/mcp            MCP server (Streamable HTTP)
packages/core       Shared business logic + DB access (Drizzle/Prisma)
packages/salesforce Salesforce client (Bulk 2.0, Pub/Sub)
db                  Schema + migrations
docs                Checklist, findings, architecture notes
docker-compose.yml  Postgres + services
```

## Getting started

```bash
# prerequisites: Node >= 22, Docker
cp .env.example .env   # once created
docker compose up -d postgres
```

Detailed setup instructions will land here as the implementation progresses.

## Deliverables

See section 10 of the [checklist](docs/POC-CHECKLIST.md#10-final-deliverables).
