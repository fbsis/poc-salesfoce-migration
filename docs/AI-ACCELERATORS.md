# AI & Integration Accelerators

Sources verified **2026-11-25**; anything I could not open is marked unverified.

**Executive summary**

1. Salesforce ships **first-party hosted MCP servers (GA, 2026-04-29)** and **retired its local DX MCP server** (`@salesforce/mcp`, EOL 2026-11-02) in favour of "skills".
2. Nothing first-party replaces a **bulk extract + checkpointed CDC** pipeline; hosted MCP is agent-permissioned CRUD, not migration.
3. Metadata discovery is solved deterministically (`describe` + Tooling API); the AI layer over it is **Beta**, so our manifest comes from API calls, not prompts.
4. LLMs are good for **drafting** field mappings, not for applying them — hallucinated target fields are a documented failure mode.
5. AppFlow is credible for small syncs, but its **10 MB event buffer can drop events**; not a stand-in for replay-checkpointed Pub/Sub.

---

## 1. Official Salesforce MCP integration

**What it is.** Salesforce-managed endpoints (`api.salesforce.com/platform/mcp/v1/...`) with fixed tool sets: `SObject All/Reads/Mutations/Deletes`, plus `Content`, `Data 360`, `Tableau Next`, `CRM Analytics` (Beta), `Headless 360` (Beta), `Metadata Grounding` (Beta). Servers are off by default and enabled in Setup → API Catalog; every call runs **as the authenticated user** with CRUD/FLS/sharing enforced ([standard servers](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/servers-reference.html), [GA announcement](https://developer.salesforce.com/blogs/2026/04/salesforce-hosted-mcp-servers-are-now-generally-available)). Auth is an **External Client App** with OAuth + PKCE ([ECA prerequisites](https://developer.salesforce.com/docs/platform/api-metadata/guide/meta-mcp-server-eca.html)); the GA blog says `mcp_api` + `refresh_token`, the ECA doc says `api`/`sfap_api` — the scope names conflict, so treat that as **unverified**.
The local `npx @salesforce/mcp` server is **EOL 2026-11-02**: repo archived, npm deprecated, replaced by [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) ([EOL issue](https://github.com/forcedotcom/mcp/issues/46)).

**Saving here.** Little. We need MCP over *Postgres* (`apps/mcp`). `platform/sobject-reads` saves ~1h checking the source org — one ECA, no code.

**Risk.** Two MCP surfaces with different permission models; an agent could read `Account` from both and disagree. Keep it read-only, outside the demo.

## 2. AI-assisted metadata discovery

**Deterministic first.** `GET /sobjects/{sObject}/describe` returns fields plus `childRelationships` with `cascadeDelete`/`restrictedDelete` ([REST describe](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-sobject-describe.html)); Tooling `EntityDefinition`/`FieldDefinition`/`RelationshipDomain` give the same graph as rows ([EntityDefinition](https://developer.salesforce.com/docs/platform/api-tooling/references/tooling-objects/tooling-entitydefinition.html), [RelationshipDomain](https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_relationshipdomain.htm)); `sf sobject describe` wraps it ([CLI](https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_sobject.html)).
**AI:** `Metadata Grounding` (Beta) searches a semantic org catalogue — `search_metadata_types`, `get_metadata_type_fields` ([reference](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/references/reference/metadata-grounding.html)) — backed by **Salesforce Catalog**, documented as GA ([help](https://help.salesforce.com/s/articleView?id=sf.catalog_overview.htm)). Beta labelling is the honest status; I could not verify a full tool manifest.

**Saving here.** None at four objects. Real at 50+, but limited to *asking better questions* — a graph query, not an LLM call.

**Risk.** A Beta server returning plausible-but-wrong field lists we then encode into a plan. The manifest comes from a committed script, diffable in git.

## 3. Custom objects and relationships

**What an extraction manifest must contain.** Per object: API name + namespace, fields with type/`nillable`/external-ID flags, `childRelationships`, `RecordType` rows with `BusinessProcessId` ([RecordType](https://developer.salesforce.com/docs/platform/object-reference/references/standard-objects/object-recordtype.html)), picklist values with `IsActive`/`IsDefaultValue`/`ValidFor` for dependent picklists ([PicklistValueInfo](https://developer.salesforce.com/docs/platform/object-reference/references/standard-objects/object-picklistvalueinfo.html)), and master-detail vs lookup — master-detail cascades deletes, a lookup restricts only if configured.

**Saving here.** None from AI: `Account → Contact → Opportunity` is three edges already hard-coded in `applySalesforceBatch` ordering. Still write the describe-driven manifest script so the list is not a comment.

**Risk.** AI guessing that `Opportunity.ContactId` carries the relationship (it does not). Master-detail children must load after parents or the batch fails on FK errors.

## 4. AI-generated data mappings

**What it is.** Schema matching. Magneto (VLDB'25) shows the working shape — cheap small-model candidate retrieval, LLM reranking — at **+6.7% MRR@k=5** over a bipartite baseline on a 700+ attribute target schema ([paper](https://arxiv.org/html/2412.08194v1), [code](https://github.com/VIDA-NYU/magneto-matcher)). An independent study finds LLMs bridge semantic gaps that string matchers miss, but are **sensitive to context scope** and emit target fields that do not exist ([arXiv 2407.11852](https://arxiv.org/html/2407.11852v1)). [Valentine](https://delftdata.github.io/valentine/) benchmarks exist, though curated names flatter every matcher.

**Saving here.** One LLM pass drafts our 4-object → column mapping in minutes; a human pastes it into a declarative file. A first draft, not a pipeline stage.

**Risk.** Even at `temperature=0` output is not guaranteed reproducible across runs ([OpenAI docs](https://developers.openai.com/api/docs/guides/advanced-usage)). Money, dates and enums never pass through an LLM.

## 5. AWS AppFlow

**What it is.** Salesforce as source *and* destination: **15 GB per flow run** (~7.5M records at 2 KB), scheduled flows **max once per minute**, CDC + platform events supported, EventBridge as destination ([connector](https://docs.aws.amazon.com/appflow/latest/userguide/salesforce.html), [EventBridge](https://docs.aws.amazon.com/appflow/latest/userguide/EventBridge.html)). **$0.001 per flow run + $0.02/GB** ([pricing](https://aws.amazon.com/appflow/pricing/)). Quotas: 1,000 flows/account, 10M runs/month, 48 h max run; Salesforce **events use a fixed 10 MB buffer and "events might be dropped"** on surges, and flows consume the org's API limit ([quotas](https://docs.aws.amazon.com/appflow/latest/userguide/service-quotas.html)).

**Saving here.** ~2 days of code — OAuth, polling and CSV parsing all vanish.

**Risk.** Documented event loss, no per-record replay bookkeeping, console-only transforms (not reviewable in git), API-consumption risk — and it hides the mechanism we are proving.

## 6. Pub/Sub API vs EventBridge

**Pub/Sub:** gRPC at `api.pubsub.salesforce.com:443|7443` ([endpoints](https://developer.salesforce.com/docs/platform/pub-sub-api/guide/pub-sub-endpoints.html)), Avro payloads ([Avro](https://developer.salesforce.com/docs/platform/pub-sub-api/guide/event-avro-serialization.html), [proto](https://github.com/forcedotcom/pub-sub-api/blob/main/pubsub_api.proto)), **72 h retention** with opaque `ReplayId` cursors ([durability](https://developer.salesforce.com/docs/platform/api-streaming/guide/using-streaming-api-durability.html)), **at-least-once** with dedupe on the event `EventUuid`, `num_requested` capped at **100**, 200 managed subscriptions/org, 1,000 concurrent streams per channel ([allocations](https://developer.salesforce.com/docs/platform/pub-sub-api/guide/allocations.html)). Permission changes take up to **10 min** to affect a live subscription ([considerations](https://developer.salesforce.com/docs/platform/pub-sub-api/guide/considerations.html)).

**Event Relay:** GA; needs a **Hyperforce** org, an AWS account, IAM trust and a partner event source you activate yourself ([overview](https://developer.salesforce.com/docs/platform/event-relay/overview), [GA post](https://developer.salesforce.com/blogs/2022/10/salesforce-event-relay-is-generally-available)). Claimed replay via `ReplayRecovery` inside the same 72 h window: **unverified** — I could not open the operational doc. No published latency SLA for either.

**Verdict.** Pub/Sub wins here because the checkpoint *is* the deliverable (`cdc_checkpoints.replay_id`), needs no AWS account, and the mock implements it exactly. EventBridge wins for AWS-native fan-out without gRPC clients — paying with a second cloud, Hyperforce, and less replay control.

## 7. HubSpot migration capabilities

**What it is.** **Smart Transfer** is a real first-party, **one-way** migration tool supporting Salesforce including **custom objects**, mapping lookups to HubSpot associations; custom field mappings need **Data Hub**, and running it next to the HubSpot-Salesforce connector creates duplicates because identifiers differ ([Smart Transfer](https://knowledge.hubspot.com/integrations/transfer-data-from-other-apps-using-hubspot-smart-transfer), [SF integration](https://knowledge.hubspot.com/salesforce/install-the-hubspot-salesforce-integration)). It cannot target Postgres.

**Saving here.** Zero direct. Its value: a funded vendor migrates objects and associations and *still* needs a mapping review — that is the floor of our effort.

**Risk.** Reading it as proof "migration is solved" — it solves mapping into *their* schema.

## 8. Where deterministic automation must win

Determinism owns everything **idempotent, replayable or audited**: extraction manifests (script → committed JSON), FK resolution and load order, `salesforce_id` upserts with `SystemModstamp` staleness, checkpoint + `EventUuid` dedupe, post-run assertions (the dbt pattern — `unique`/`not_null`/`relationships` tests fail the build on bad rows: [dbt tests](https://docs.getdbt.com/reference/resource-properties/data-tests), [contracts](https://docs.getdbt.com/docs/mesh/govern/model-contracts)), and every MCP tool's schema and auth check.
AI owns **reading and drafting**: failed-batch explanations, first-pass mapping, prose summaries, "which accounts are stale?".

---

## Decision table

| capability | use AI | use deterministic code | why |
|---|---|---|---|
| Object/field inventory | no | yes — describe/Tooling → committed manifest | must be diffable, re-runnable |
| First-draft field mapping | yes (draft only) | yes — mapping file + dry run | LLMs invent target fields |
| Picklist / record-type translation | no | yes — value tables | silent data loss |
| FK resolution + load order | no | yes — topological sort | FK violations are hard failures |
| Idempotent upsert / staleness | no | yes — `salesforce_id` + `SystemModstamp` | replays must be safe |
| CDC checkpoint & dedupe | no | yes — `replay_id` + `EventUuid` | at-least-once is the contract |
| Sync failure triage | yes | partial — typed errors decide retry | reading a log ≠ deciding correctness |
| MCP tool contracts | no | yes — zod + bearer auth | security boundary |
| "Which accounts are stale?" | yes | yes — MCP query tool | agent picks tool, code runs SQL |
| Migration docs | yes (draft) | engineer review | prose is cheap to fix, data is not |

---

## What we will NOT do in this POC

- **Depend on a Salesforce hosted MCP server.** It exposes the source org, not our CRM.
- **Build on `@salesforce/mcp`.** EOL 2026-11-02, archived, deprecated ([issue](https://github.com/forcedotcom/mcp/issues/46)).
- **Put AppFlow in the pipeline.** Its 10 MB buffer "might drop" events and transforms live in a console.
- **Use Event Relay.** Hyperforce + AWS account + partner event source for events we already stream.
- **Call an LLM inside the apply/CDC loop.** Non-deterministic on financial fields, unreproducible failures.
- **Hand-write or prompt the migration manifest.** A script generates it; git shows the diff.
- **Auto-migrate arbitrary custom objects.** Four objects, explicit manifest.
- **Claim numbers we did not measure.** Pub/Sub vs EventBridge latency is unbenchmarked and undocumented by Salesforce.
