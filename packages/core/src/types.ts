/**
 * Public domain types for `@poc/core`.
 *
 * The entity interfaces below are copied verbatim from docs/CONTRACTS.md §3 —
 * do not rename fields. DB columns are snake_case; every value that leaves this
 * package is already mapped (camelCase keys, dates as ISO strings, `amount` as
 * a string because it is a `numeric` column).
 */

// ------------------------------------------------------------------- enums

export type OpportunityStage =
  | 'Prospecting'
  | 'Qualification'
  | 'Proposal'
  | 'Negotiation'
  | 'Closed Won'
  | 'Closed Lost';

export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'closed';
export type LeadSource = 'landing_page' | 'salesforce' | 'manual';
export type EntitySource = 'salesforce' | 'local';
export type ChangeType = 'CREATE' | 'UPDATE' | 'DELETE' | 'UNDELETE';
export type CdcEventStatus = 'pending' | 'applied' | 'skipped_stale' | 'ignored' | 'failed';
export type SyncRunKind = 'bulk_extract' | 'cdc' | 'reconcile';
export type SyncRunStatus = 'running' | 'success' | 'failed';
export type CheckpointStatus = 'idle' | 'connected' | 'replaying' | 'error';

/** Canonical ordering used by `getOpportunitiesByStage`. */
export const OPPORTUNITY_STAGES: readonly OpportunityStage[] = [
  'Prospecting',
  'Qualification',
  'Proposal',
  'Negotiation',
  'Closed Won',
  'Closed Lost',
];

export const LEAD_STATUSES: readonly LeadStatus[] = ['new', 'contacted', 'qualified', 'closed'];

export const LEAD_SOURCES: readonly LeadSource[] = ['landing_page', 'salesforce', 'manual'];

export const CHANGE_TYPES: readonly ChangeType[] = ['CREATE', 'UPDATE', 'DELETE', 'UNDELETE'];

export const CDC_EVENT_STATUSES: readonly CdcEventStatus[] = [
  'pending',
  'applied',
  'skipped_stale',
  'ignored',
  'failed',
];

// ----------------------------------------------------------------- entities

export interface Account {
  id: string;
  salesforce_id: string | null;
  name: string;
  industry: string | null;
  website: string | null;
  billing_country: string | null;
  owner_name: string | null;
  source: EntitySource;
  salesforce_updated_at: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  salesforce_id: string | null;
  account_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  source: EntitySource;
  salesforce_updated_at: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
  account_name?: string | null;
}

export interface Opportunity {
  id: string;
  salesforce_id: string | null;
  account_id: string | null;
  name: string;
  stage: OpportunityStage;
  amount: string; // numeric(14,2) serialised as string
  close_date: string | null;
  owner_name: string | null;
  probability: number | null;
  source: EntitySource;
  salesforce_updated_at: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
  account_name?: string | null;
}

export interface Lead {
  id: string;
  salesforce_id: string | null;
  full_name: string;
  email: string;
  phone: string | null;
  company: string | null;
  property_interest: string | null;
  message: string | null;
  status: LeadStatus;
  source: LeadSource;
  consent: boolean;
  consent_at: string | null;
  salesforce_updated_at: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Paged<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// ------------------------------------------------------ cdc / sync entities

export interface SyncRun {
  id: string;
  kind: SyncRunKind;
  status: SyncRunStatus;
  started_at: string;
  finished_at: string | null;
  records_read: number;
  records_written: number;
  error: string | null;
  details: unknown | null;
}

export interface CdcCheckpoint {
  channel: string;
  replay_id: string | null;
  last_event_at: string | null;
  status: string;
  error: string | null;
  updated_at: string;
}

export interface CdcEvent {
  id: string;
  event_id: string;
  channel: string;
  object_name: string;
  record_id: string;
  change_type: ChangeType;
  replay_id: string | null;
  payload: unknown | null;
  status: CdcEventStatus;
  error: string | null;
  latency_ms: number | null;
  received_at: string;
  processed_at: string | null;
}

// ------------------------------------------------------------ report shapes

export interface SalesSummary {
  accounts: number;
  contacts: number;
  opportunities: number;
  leads: number;
  pipelineValue: number;
  wonValue: number;
  openOpportunities: number;
  newLeads: number;
  salesforceRecords: number;
  localRecords: number;
}

export interface StageSummary {
  stage: OpportunityStage;
  count: number;
  totalAmount: number;
}

export interface LeadSummary {
  total: number;
  byStatus: Array<{ status: LeadStatus; count: number }>;
  bySource: Array<{ source: LeadSource; count: number }>;
  newToday: number;
  latest: Lead[];
}

export interface SyncStatus {
  running: boolean;
  lastBulkRun: SyncRun | null;
  lastCdcEventAt: string | null;
  checkpoints: CdcCheckpoint[];
  counts: { cdcEvents: number; failedEvents: number; staleSkipped: number };
  lagSeconds: number | null;
}

// ------------------------------------------------------------- input shapes
// Mirrors of the inline input types in CONTRACTS.md §3, exported so the HTTP
// API and the MCP server can reuse a single shape.

export interface ListAccountsParams {
  search?: string;
  source?: EntitySource;
  limit?: number;
  offset?: number;
}

export interface CreateAccountInput {
  name: string;
  industry?: string | null;
  website?: string | null;
  billing_country?: string | null;
  owner_name?: string | null;
}

export interface UpdateAccountInput {
  name?: string;
  industry?: string | null;
  website?: string | null;
  billing_country?: string | null;
  owner_name?: string | null;
}

export interface ListContactsParams {
  search?: string;
  account_id?: string;
  limit?: number;
  offset?: number;
}

export interface CreateContactInput {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  account_id?: string | null;
}

export interface UpdateContactInput {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  account_id?: string | null;
}

export interface ListOpportunitiesParams {
  search?: string;
  stage?: OpportunityStage;
  account_id?: string;
  limit?: number;
  offset?: number;
}

export interface CreateOpportunityInput {
  name: string;
  account_id?: string | null;
  stage?: OpportunityStage;
  amount?: number | string;
  close_date?: string | null;
  owner_name?: string | null;
  probability?: number | null;
}

export interface UpdateOpportunityInput {
  name?: string;
  account_id?: string | null;
  stage?: OpportunityStage;
  amount?: number | string;
  close_date?: string | null;
  owner_name?: string | null;
  probability?: number | null;
}

export interface ListLeadsParams {
  search?: string;
  status?: LeadStatus;
  source?: LeadSource;
  created_since?: string;
  limit?: number;
  offset?: number;
}

export interface CreateLeadInput {
  full_name: string;
  email: string;
  phone?: string | null;
  company?: string | null;
  property_interest?: string | null;
  message?: string | null;
  source?: LeadSource;
  status?: LeadStatus;
  consent?: boolean;
}

export interface UpdateLeadInput {
  full_name?: string;
  email?: string;
  phone?: string | null;
  company?: string | null;
  property_interest?: string | null;
  message?: string | null;
  status?: LeadStatus;
}

export interface LeadSummaryParams {
  since?: string;
}

export interface RecordCdcEventInput {
  event_id: string;
  channel: string;
  object_name: string;
  record_id: string;
  change_type: ChangeType;
  replay_id: bigint | string | null;
  payload: unknown;
  latency_ms?: number;
}

export interface SyncRunPatch {
  status: 'success' | 'failed';
  records_read?: number;
  records_written?: number;
  error?: string;
  details?: unknown;
}

export interface CheckpointPatch {
  status?: string;
  error?: string | null;
  last_event_at?: string;
}
