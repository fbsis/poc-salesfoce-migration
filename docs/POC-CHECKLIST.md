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
- [ ] Validate Bulk API 2.0 access.
- [ ] Document API limits and relevant permissions.

### Initial Data Migration

- [ ] Extract Salesforce Accounts.
- [ ] Extract Contacts and Opportunities.
- [ ] Import data into PostgreSQL.
- [ ] Preserve original Salesforce IDs.
- [ ] Preserve relationships between entities.
- [ ] Implement idempotent upsert operations.
- [ ] Validate record counts and data consistency.

### Change Data Capture

- [ ] Connect to Salesforce Pub/Sub API.
- [ ] Subscribe to Account and Opportunity events.
- [ ] Handle CREATE, UPDATE, DELETE, and UNDELETE.
- [ ] Persist replay checkpoints.
- [ ] Implement reconnect and replay.
- [ ] Handle duplicate events.
- [ ] Investigate event ordering.
- [ ] Measure synchronization latency.

### Migration Consistency

- [ ] Capture changes during initial extraction.
- [ ] Prevent older snapshots from overwriting newer updates.
- [ ] Test concurrent changes.
- [ ] Implement basic reconciliation.
- [ ] Document recovery limitations and cutover strategy.

For this POC, Salesforce remains authoritative for imported records.

---

## 4. Minimal Internal CRM

Build a small CRM with Next.js, TypeScript, and Tailwind CSS.

### Dashboard

- [ ] Total Accounts.
- [ ] Total Contacts.
- [ ] Total Opportunities.
- [ ] Total Leads.
- [ ] Recent Leads.
- [ ] Opportunities by stage.
- [ ] Salesforce synchronization status.

### Accounts

- [ ] List Accounts.
- [ ] View Account details.
- [ ] Create and update local Accounts.
- [ ] Search Accounts.

### Contacts

- [ ] List Contacts.
- [ ] View Contact details.
- [ ] Associate Contacts with Accounts.

### Opportunities

- [ ] List Opportunities.
- [ ] Create and update local Opportunities.
- [ ] Display stage, amount, and expected close date.
- [ ] Filter by stage.

### Leads

- [ ] List Leads.
- [ ] View Lead details.
- [ ] Search Leads.
- [ ] Filter by status.
- [ ] Update Lead status: New, Contacted, Qualified, Closed.
- [ ] Display Lead source.
- [ ] Display Lead creation date.

Keep the UI simple: navigation, tables, forms, and basic status indicators.

---

## 5. Public Lead Capture Page

Create a simple public landing page where potential customers can manually register their interest.

This page represents a real business workflow: **a visitor becomes a lead inside the internal CRM without using Salesforce.**

### Public Page

Route: `/lead`

- [ ] Create a simple responsive landing page using Tailwind CSS.
- [ ] Display a title such as "Find Your Next Home".
- [ ] Add a short description inviting visitors to register.
- [ ] Create a lead registration form.
- [ ] Show a success message after submission.
- [ ] Display validation errors.

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

- [ ] Implement `POST /api/leads`.
- [ ] Validate and sanitize submitted input.
- [ ] Save the Lead directly into PostgreSQL.
- [ ] Generate a unique Lead ID.
- [ ] Set `source = "landing_page"`.
- [ ] Set `status = "new"`.
- [ ] Store the creation timestamp.
- [ ] Add basic duplicate detection by email.
- [ ] Add basic rate limiting or spam protection.
- [ ] Avoid exposing CRM administrative endpoints publicly.

### CRM Integration

- [ ] Display submitted Leads in the CRM.
- [ ] Show new Leads on the dashboard.
- [ ] Allow users to inspect Lead details.
- [ ] Allow users to update Lead status.
- [ ] Display the original Lead source.

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

- [ ] Create a Node.js MCP server.
- [ ] Implement Streamable HTTP transport.
- [ ] Connect to internal CRM services.
- [ ] Define structured tool inputs and outputs.
- [ ] Validate parameters.
- [ ] Add minimal access controls.
- [ ] Test using an MCP-compatible AI client.

### MCP Tools

**Accounts**

- [ ] `list_accounts`
- [ ] `get_account`
- [ ] `search_accounts`
- [ ] `create_account`
- [ ] `update_account`

**Opportunities**

- [ ] `list_opportunities`
- [ ] `get_opportunity`
- [ ] `create_opportunity`
- [ ] `update_opportunity`

**Leads**

- [ ] `list_leads`
- [ ] `get_lead`
- [ ] `search_leads`
- [ ] `update_lead_status`

**Reporting**

- [ ] `get_sales_summary`
- [ ] `get_opportunities_by_stage`
- [ ] `get_lead_summary`
- [ ] `get_sync_status`

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

- [ ] Research official Salesforce MCP integrations.
- [ ] Explore AI-assisted Salesforce metadata discovery.
- [ ] Identify custom objects and relationships.
- [ ] Evaluate AI-generated data mappings.
- [ ] Investigate AWS AppFlow.
- [ ] Compare Pub/Sub API with EventBridge-based integration.
- [ ] Evaluate relevant HubSpot migration capabilities.
- [ ] Identify opportunities for deterministic automation.
- [ ] Distinguish useful AI automation from unnecessary complexity.

MCP should accelerate discovery and business operations, not replace reliable data migration pipelines.

---

## 8. Technical Testing

### Salesforce Migration

- [ ] Import records from Salesforce.
- [ ] Validate field mappings and relationships.
- [ ] Verify record counts.
- [ ] Test idempotency.
- [ ] Validate data consistency.

### CDC

- [ ] Test CREATE.
- [ ] Test UPDATE.
- [ ] Test DELETE.
- [ ] Test consumer interruption.
- [ ] Test replay after reconnection.
- [ ] Check synchronization latency.

### Lead Capture

- [ ] Submit a Lead from the public landing page.
- [ ] Verify PostgreSQL persistence.
- [ ] Confirm the Lead appears in the CRM.
- [ ] Test required field validation.
- [ ] Test duplicate email behavior.
- [ ] Update Lead status.
- [ ] Query the Lead through MCP.

### MCP

- [ ] Connect a real AI client.
- [ ] Discover available tools.
- [ ] Query Accounts and Opportunities.
- [ ] Query newly registered Leads.
- [ ] Update a Lead through an MCP tool.
- [ ] Verify the change in the CRM interface.
- [ ] Reject unauthorized operations.

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

- [ ] Minimal Next.js CRM with Tailwind CSS.
- [ ] Public lead capture landing page.
- [ ] Working Lead registration API.
- [ ] PostgreSQL database.
- [ ] Salesforce Bulk API integration.
- [ ] Salesforce CDC consumer.
- [ ] Functional MCP server.
- [ ] AI agent connected to CRM through MCP.
- [ ] Basic automated tests.
- [ ] Docker Compose environment.
- [ ] Architecture diagram.
- [ ] README and setup instructions.
- [ ] Technical findings and limitations.
- [ ] Recommendations for production migration.

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
