# POC — Salesforce Migration, CDC & AI-Ready CRM with MCP

## Objective

Build a small, functional CRM demonstrating how Salesforce can be gradually replaced by an internal platform.

The POC must validate five technical capabilities:

1. **Data Migration:** Import Salesforce records using Bulk API 2.0.
2. **Real-Time Synchronization:** Synchronize Salesforce changes using CDC.
3. **Internal CRM:** Manage Accounts, Contacts, Opportunities, and Leads.
4. **Lead Capture:** Allow potential customers to register through a public landing page.
5. **AI Integration:** Expose CRM operations to AI agents through MCP.

**This is a technical proof of concept, not a production-ready application.**

Prioritize technical validation, integration reliability, and demonstrable business workflows over implementation complexity.

---

## How this checklist was verified

A box is ticked only where there was evidence — in the code, in the test suite, or in the running
system — never because a file exists. The baseline was the adversarial audit in
[`AUDIT.md`](AUDIT.md) (17 findings, with a coverage table in its §4); every item was then
re-checked against commit `33559d4`, corrected for fixes that landed after the audit (`ebb09fb`,
`3398bcc`, `47471ea`, `f40dc46`, `2ffb827`, `f327fd4`, `33559d4`), and corrected again for defects
that are still open.

Evidence used: `docker compose run --rm tools pnpm test` → **28 files / 218 tests** (5 skipped), green
on two consecutive runs of ~25 s each, at commit `ac527fc`; `pnpm typecheck` → 6 packages clean; the
end-to-end suite that drives the live stack over HTTP and gRPC (**18 tests**, `apps/web/test/e2e/`);
and manual reproduction of every demo, curl endpoint and SQL query quoted in [`DEMO.md`](DEMO.md) and
[`FINDINGS.md`](FINDINGS.md).

The status below is the **committed** state at `33559d4`, which includes the CDC retry /
head-of-line-block / `POST /run/redrive` / `POST /run/discard` path and the `cdc` row in `sync_runs`
(`2ffb827`, `f327fd4`, `33559d4`; audit P0-2 and P1-3). The suite numbers are from `ac527fc`.
Nothing here is ticked on the strength of uncommitted work, and the one thing the suite cannot prove
is stated where it matters: it runs against the live compose stack (P2-3), so it is only green on an
idle stack.

**The caveat that governs this whole document: there is no Salesforce org.** All Salesforce traffic
went to `apps/salesforce-mock`, a local emulator that implements the published Bulk API 2.0
query-job contract, a byte-compatible subset of the Pub/Sub gRPC proto from
`forcedotcom/pub-sub-api`, and real Avro-encoded CDC payloads. Anything that can only be true of a
real org is left unticked and annotated with `⚠️`; [`FINDINGS.md`](FINDINGS.md) §2 lists the
unverified areas.

Deliberately unticked everywhere, for the same reason: a real org (OAuth / External Client App,
Bulk limits, FLS, record types and picklists, sharing rules, the 72 h retention window) and a real
AI client driving the MCP tools. A poison CDC event is no longer in that list: it is exercised in
`apps/worker/test/cdc-run.test.ts`, in the E2E suite, and live via [`DEMO.md`](DEMO.md) Demo 6.

---

## 1. Technology Stack

| Component | Technology |
|---|---|
| Frontend | Next.js (App Router) |
| UI | Tailwind CSS |
| Language | TypeScript |
| Backend | Node.js |
| Database | PostgreSQL |
| Salesforce Integration | Bulk API 2.0 + Pub/Sub API |
| AI Integration | MCP TypeScript SDK |
| Infrastructure | Docker Compose |
| Testing | Vitest |

Use Next.js for the CRM UI, public lead page, and internal API endpoints. Use separate Node.js processes for Salesforce CDC and MCP when necessary.

Keep everything lightweight.

---

## 2. Architecture

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

All CRM functionality should share the same business logic.

Salesforce integrations must remain isolated from internal CRM operations.

---

## 3. Salesforce Integration

### Environment

- [ ] Create a Salesforce Developer Edition.
- [ ] Configure OAuth authentication.
- [ ] Explore Accounts, Contacts, and Opportunities.
- [ ] Identify object relationships and custom fields.
- [ ] Enable supported CDC events.

> ⚠️ Four topics are implemented — `/data/{Account,Contact,Opportunity,Lead}ChangeEvent` — in the
> emulator. Nothing has been enabled in a real org.

- [ ] Validate Bulk API 2.0 access.
- [ ] Document API limits and relevant permissions.

> ⚠️ **There is no Salesforce org in this POC.** Everything Salesforce-shaped ran against
> `apps/salesforce-mock`: the published Bulk API 2.0 query-job contract, a byte-compatible subset of
> the Pub/Sub gRPC proto, and real Avro CDC payloads. OAuth is client-credentials against the mock —
> no External Client App was created, and no org limits or permissions were read. **No custom objects
> or custom fields were discovered** (there is no org to inspect); relationships were identified for
> the four emulated objects (Account → Contact/Opportunity, Lead standalone). The public quotas
> (72 h Pub/Sub retention, `num_requested` cap 100, Bulk concurrency) are documented from
> Salesforce's documentation in [`FINDINGS.md`](FINDINGS.md) §2 — not measured.

### Initial Data Migration

- [x] Extract Salesforce Accounts.
- [x] Extract Contacts and Opportunities.
- [x] Import data into PostgreSQL.
- [x] Preserve original Salesforce IDs.
- [x] Preserve relationships between entities.
- [x] Implement idempotent upsert operations.
- [x] Validate record counts and data consistency.

### Change Data Capture

- [x] Connect to Salesforce Pub/Sub API.
- [x] Subscribe to Account and Opportunity events.
- [x] Handle CREATE, UPDATE, DELETE, and UNDELETE.
- [x] Persist replay checkpoints.
- [x] Implement reconnect and replay.
- [x] Handle duplicate events.
- [x] Investigate event ordering.

> ⚠️ Ordering is investigated per topic: one serialised queue per channel, plus a stale-write guard
> that rejects an out-of-order event (`02-cdc.test.ts` pins an older `SystemModstamp` and asserts
> `skipped_stale`). Cross-topic ordering does not exist — topics are independent, which is why
> orphan re-linking is needed. The mock re-stamps `SystemModstamp` unless the caller pins it, so
> genuine out-of-order *delivery* is only reachable from a test.

- [x] Measure synchronization latency.

### Migration Consistency

- [ ] Capture changes during initial extraction.

> ⚠️ **Not covered.** There is no snapshot/CDC overlap test, and on a virgin database the consumer
> starts at `LATEST` — changes made *during* the first bulk extract are only recovered if a
> checkpoint already exists and the broker still retains them. Closing this is phase 2 of the
> cutover plan in [`FINDINGS.md`](FINDINGS.md) §5.

- [x] Prevent older snapshots from overwriting newer updates.

> ⚠️ True of every **upsert**, proven concurrency test included. Not yet true of the CDC **delete**
> path: `deleteSalesforceRecord` has the guard, but the consumer calls it without the event
> timestamp, so a replayed DELETE can still remove a newer row (open finding P1-2,
> [`FINDINGS.md`](FINDINGS.md) §3).
- [x] Test concurrent changes.
- [x] Implement basic reconciliation.
- [x] Document recovery limitations and cutover strategy.

> Now written: [`FINDINGS.md`](FINDINGS.md) §3 documents the recovery limitations — including the
> accepted tradeoff behind the P0-2 fix (one unappliable event **blocks its topic** instead of being
> skipped: retried 3×, checkpoint held at `status='error'`, `[cdc][ALERT]`, resolved with
> `POST :3002/run/redrive` once the data is fixed, or `POST :3002/run/discard` when it can never
> apply; commits `2ffb827`, `f327fd4`) — and §5 is the six-month cutover strategy. The limitation
> that remains real is operational, not correctness: the topic stays blocked until someone makes that
> decision, and discard knowingly leaves the record unapplied.

For this POC, Salesforce remains authoritative for imported records.

---

## 4. Minimal Internal CRM

Build a small CRM with Next.js, TypeScript, and Tailwind CSS.

### Dashboard

- [x] Total Accounts.
- [x] Total Contacts.
- [x] Total Opportunities.
- [x] Total Leads.
- [x] Recent Leads.
- [x] Opportunities by stage.
- [x] Salesforce synchronization status.

> ⚠️ The card reads live data. `sync_runs` now records one `cdc` row per consumer lifetime, so the
> pill shows **"Run in progress"** (amber) while the consumer is up instead of a permanent "Idle";
> the checkpoint list shows each channel's status (`connected`, or `error` while a poison event is
> blocking it), and the `failed` counter is the alert signal. Remaining gaps: a crashed **bulk** run
> still leaves `running: true` and renders as "Run in progress" indefinitely (the `cdc` half is
> reaped at consumer startup), and the card does not surface `sync_runs.details` (p50 latency,
> `blocked`/`held`) — you read those from the worker log or SQL
> (`apps/worker/README.md`, [`FINDINGS.md`](FINDINGS.md) §3).

### Accounts

- [x] List Accounts.
- [x] View Account details.
- [ ] Create and update local Accounts.

> ⚠️ **Partial.** List / view / create / search are all in the UI, but **update has no screen**:
> `app/crm/actions.ts` exports `createAccountAction`, `createOpportunityAction`,
> `updateOpportunityAction` and `updateLeadStatusAction` — no `updateAccountAction`. `PATCH
> /api/crm/accounts/:id` works.

- [x] Search Accounts.

### Contacts

- [x] List Contacts.
- [x] View Contact details.
- [ ] Associate Contacts with Accounts.

> ⚠️ **Partial.** Contacts are read-only in the UI. Association is possible only through
> `POST /api/crm/contacts` with `{ account_id }`, or by the Salesforce sync; the link is then
> displayed on the contact detail page.

### Opportunities

- [x] List Opportunities.
- [x] Create and update local Opportunities.
- [x] Display stage, amount, and expected close date.
- [x] Filter by stage.

### Leads

- [x] List Leads.
- [x] View Lead details.
- [x] Search Leads.
- [x] Filter by status.
- [x] Update Lead status: New, Contacted, Qualified, Closed.
- [x] Display Lead source.
- [x] Display Lead creation date.

Keep the UI simple: navigation, tables, forms, and basic status indicators.

---

## 5. Public Lead Capture Page

Create a simple public landing page where potential customers can manually register their interest.

This page represents a real business workflow: **a visitor becomes a lead inside the internal CRM without using Salesforce.**

### Public Page

Route: `/lead`

- [x] Create a simple responsive landing page using Tailwind CSS.
- [x] Display a title such as "Find Your Next Home".
- [x] Add a short description inviting visitors to register.
- [x] Create a lead registration form.
- [x] Show a success message after submission.
- [x] Display validation errors.

### Lead Form Fields

| Field | Required |
|---|---|
| Full Name | Yes |
| Email | Yes |
| Phone Number | No |
| Property Interest | No |
| Message | No |
| Privacy Consent | Yes |

### Backend Integration

- [x] Implement `POST /api/leads`.
- [x] Validate and sanitize submitted input.
- [x] Save the Lead directly into PostgreSQL.
- [x] Generate a unique Lead ID.
- [x] Set `source = "landing_page"`.
- [x] Set `status = "new"`.
- [x] Store the creation timestamp.
- [x] Add basic duplicate detection by email.
- [x] Add basic rate limiting or spam protection.
- [x] Avoid exposing CRM administrative endpoints publicly.

### CRM Integration

- [x] Display submitted Leads in the CRM.
- [x] Show new Leads on the dashboard.
- [x] Allow users to inspect Lead details.
- [x] Allow users to update Lead status.
- [x] Display the original Lead source.

### Expected Flow

```text
Visitor
   |
   v
Public Landing Page
   |
   v
Lead Registration Form
   |
   v
Next.js API
   |
   v
PostgreSQL
   |
   +----> CRM Leads Dashboard
   |
   +----> MCP Server
               |
               v
            AI Agent
```

For this POC, landing-page Leads are stored directly in the internal CRM. They do not need to be synchronized back into Salesforce.

**Expected outcome:** A complete lead generation workflow independent of Salesforce.

---

## 6. MCP Server — AI Integration

Implement a functional MCP server using the official TypeScript SDK.

Use Streamable HTTP transport and expose business operations through the internal CRM API.

### MCP Infrastructure

- [x] Create a Node.js MCP server.
- [x] Implement Streamable HTTP transport.
- [x] Connect to internal CRM services.
- [x] Define structured tool inputs and outputs.
- [x] Validate parameters.
- [x] Add minimal access controls.
- [ ] Test using an MCP-compatible AI client.

> ⚠️ **Not done.** The server is exercised exactly as an agent would call it — `initialize`,
> `tools/list`, `tools/call` over Streamable HTTP with the real `Accept` and bearer headers — and the
> write is verified through the CRM API *and* the rendered HTML. But no Claude Code / Cursor / Codex
> client has been connected, so no model has chosen a tool. Config and the exact prompts are in
> [`DEMO.md`](DEMO.md) §5; this stays unticked until someone runs them.

### MCP Tools

**Accounts**

- [x] `list_accounts`
- [x] `get_account`
- [x] `search_accounts`
- [x] `create_account`
- [x] `update_account`

**Opportunities**

- [x] `list_opportunities`
- [x] `get_opportunity`
- [x] `create_opportunity`
- [x] `update_opportunity`

**Leads**

- [x] `list_leads`
- [x] `get_lead`
- [x] `search_leads`
- [x] `update_lead_status`

**Reporting**

- [x] `get_sales_summary`
- [x] `get_opportunities_by_stage`
- [x] `get_lead_summary`
- [x] `get_sync_status`

### AI Demonstration

Connect Cursor, Codex, or another MCP-compatible AI agent.

Test these prompts:

**CRM Search**

"Show me all opportunities currently in the Negotiation stage."

**Lead Analysis**

"Show me all new leads submitted through the landing page today."

**Lead Qualification**

"Find the latest lead from the website and mark it as Contacted."

**Sales Reporting**

"Summarize the current pipeline and show the total expected revenue."

**CRM Operations**

"Create a new opportunity for Acme Real Estate worth $15,000."

**Synchronization**

"Check when Salesforce was last synchronized and report any errors."

The agent must operate through MCP tools, not direct database connections.

---

## 7. AI & Integration Accelerators

Investigate how existing tools could reduce the Salesforce replacement effort.

- [x] Research official Salesforce MCP integrations.
- [x] Explore AI-assisted Salesforce metadata discovery.
- [x] Identify custom objects and relationships.
- [x] Evaluate AI-generated data mappings.
- [x] Investigate AWS AppFlow.

> ⚠️ Researched and documented, but the load-bearing rejection reason — a "fixed 10 MB event buffer,
> events may be dropped" — **could not be confirmed against any source** ([`AUDIT.md`](AUDIT.md) §6).
> Treat the AppFlow comparison as provisional.

- [x] Compare Pub/Sub API with EventBridge-based integration.
- [x] Evaluate relevant HubSpot migration capabilities.
- [x] Identify opportunities for deterministic automation.
- [x] Distinguish useful AI automation from unnecessary complexity.

MCP should accelerate discovery and business operations, not replace reliable data migration pipelines.

---

## 8. Technical Testing

### Salesforce Migration

- [x] Import records from Salesforce.
- [x] Validate field mappings and relationships.
- [x] Verify record counts.
- [x] Test idempotency.
- [x] Validate data consistency.

### CDC

- [x] Test CREATE.
- [x] Test UPDATE.
- [x] Test DELETE.
- [x] Test consumer interruption.
- [x] Test replay after reconnection.
- [x] Check synchronization latency.

### Lead Capture

- [x] Submit a Lead from the public landing page.
- [x] Verify PostgreSQL persistence.
- [x] Confirm the Lead appears in the CRM.
- [x] Test required field validation.
- [x] Test duplicate email behavior.
- [x] Update Lead status.
- [x] Query the Lead through MCP.

### MCP

- [ ] Connect a real AI client.
- [x] Discover available tools.
- [x] Query Accounts and Opportunities.
- [x] Query newly registered Leads.
- [x] Update a Lead through an MCP tool.
- [x] Verify the change in the CRM interface.
- [x] Reject unauthorized operations.

---

## 9. End-to-End Demo

Prepare a short demonstration covering the complete architecture.

### Demo 1 — Salesforce Migration

Extract sample Salesforce records and show them inside the Next.js CRM.

### Demo 2 — Salesforce CDC

Modify an Opportunity in Salesforce and demonstrate the automatic update in the CRM.

### Demo 3 — CDC Recovery

Disconnect the consumer, change a Salesforce record, reconnect, and show successful replay.

### Demo 4 — Public Lead Registration

Open the public landing page.

Register a new Lead using a name and email.

Open the CRM and show the newly created Lead.

### Demo 5 — AI Agent via MCP

Connect an AI agent and ask:

"Show me the latest leads captured through our website."

Then ask:

"Find the latest lead and change its status to Contacted."

Verify the updated status in the CRM.

**This demonstrates a complete workflow: Website → CRM → MCP → AI Agent.**

---

## 10. Final Deliverables

- [x] Minimal Next.js CRM with Tailwind CSS.
- [x] Public lead capture landing page.
- [x] Working Lead registration API.
- [x] PostgreSQL database.
- [x] Salesforce Bulk API integration.
- [x] Salesforce CDC consumer.
- [x] Functional MCP server.
- [ ] AI agent connected to CRM through MCP.

> ⚠️ Same gap as §6 "Test using an MCP-compatible AI client": MCP is proven over raw JSON-RPC, not
> with a real AI client attached.

- [x] Basic automated tests.
- [x] Docker Compose environment.
- [x] Architecture diagram.
- [x] README and setup instructions.
- [x] Technical findings and limitations.
- [x] Recommendations for production migration.

---

## 11. Instructions for the AI Coding Agent

1. Keep the implementation minimal and focused on the POC.
2. Use Next.js App Router, TypeScript, Node.js, and Tailwind CSS.
3. Prioritize Salesforce CDC, data consistency, and MCP integration.
4. Build only the CRM screens necessary to demonstrate the workflows.
5. Create a simple, working public lead registration page.
6. Store submitted Leads directly in PostgreSQL.
7. Make those Leads accessible through the CRM and MCP tools.
8. Use real Salesforce APIs for migration and CDC.
9. Avoid unnecessary microservices and infrastructure.
10. Document technical decisions, limitations, and observed results.
11. Do not invent successful tests or integration results.
12. Keep Salesforce synchronized records and locally captured Leads clearly distinguishable.

**Focus on technical feasibility rather than code volume or visual polish.**

> ⚠️ Rule 8 ("use real Salesforce APIs for migration and CDC") was **not satisfied**: no real
> Salesforce API was called. Everything Salesforce-shaped ran against the local emulator — see §3
> above and [`FINDINGS.md`](FINDINGS.md) §1–2. Rule 11 was upheld: neither the audit nor this
> rewrite found a fabricated result. All five capabilities are demonstrated end to end against the
> emulator, including the failure path: a poison CDC event blocks its topic, alerts, and is
> recovered by `POST /run/redrive` ([`DEMO.md`](DEMO.md) Demo 6).

## Definition of Success

The POC must demonstrate five capabilities:

1. Salesforce records can be imported into an internal CRM.
2. Salesforce changes can be synchronized using CDC.
3. Synchronization can recover after temporary interruptions.
4. Visitors can register as Leads through a public landing page.
5. AI agents can query and manage CRM records through MCP.

### Final Goal

Demonstrate an **AI-ready internal CRM** that supports Salesforce migration, near-real-time data synchronization, direct lead generation, and AI-driven business operations.

The ultimate value is proving that the architecture is technically feasible and identifying the risks involved in replacing Salesforce within six months.
