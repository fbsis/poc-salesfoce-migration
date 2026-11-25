/**
 * Row → domain mapping. DB columns are snake_case and timestamps arrive as
 * `Date`; the boundary converts to ISO strings, bigints to strings and keeps
 * `numeric` as a string so no precision is lost in JSON.
 */
import type {
  Account,
  CdcCheckpoint,
  CdcEvent,
  ChangeType,
  Contact,
  CdcEventStatus,
  EntitySource,
  Lead,
  LeadSource,
  LeadStatus,
  Opportunity,
  OpportunityStage,
  SyncRun,
  SyncRunKind,
  SyncRunStatus,
} from './types';

export type TimestampLike = Date | string | null;

export function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function isoRequired(value: unknown): string {
  return iso(value) ?? '';
}

export function dateOnly(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = String(value).trim();
  return raw === '' ? null : raw.slice(0, 10);
}

export function numericString(value: unknown, fallback = '0'): string {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? value : String(value);
}

export function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export function intZero(value: unknown): number {
  return intOrNull(value) ?? 0;
}

export function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

// ------------------------------------------------------------------- rows

export type AccountRow = {
  id: string;
  salesforce_id: string | null;
  name: string;
  industry: string | null;
  website: string | null;
  billing_country: string | null;
  owner_name: string | null;
  source: EntitySource;
  salesforce_updated_at: TimestampLike;
  synced_at: TimestampLike;
  created_at: TimestampLike;
  updated_at: TimestampLike;
};

export function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    salesforce_id: row.salesforce_id,
    name: row.name,
    industry: textOrNull(row.industry),
    website: textOrNull(row.website),
    billing_country: textOrNull(row.billing_country),
    owner_name: textOrNull(row.owner_name),
    source: row.source,
    salesforce_updated_at: iso(row.salesforce_updated_at),
    synced_at: iso(row.synced_at),
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
  };
}

export type ContactRow = {
  id: string;
  salesforce_id: string | null;
  account_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  source: EntitySource;
  salesforce_updated_at: TimestampLike;
  synced_at: TimestampLike;
  created_at: TimestampLike;
  updated_at: TimestampLike;
  account_name?: string | null;
};

export function mapContact(row: ContactRow): Contact {
  return {
    id: row.id,
    salesforce_id: row.salesforce_id,
    account_id: row.account_id,
    first_name: textOrNull(row.first_name),
    last_name: textOrNull(row.last_name),
    email: textOrNull(row.email),
    phone: textOrNull(row.phone),
    title: textOrNull(row.title),
    source: row.source,
    salesforce_updated_at: iso(row.salesforce_updated_at),
    synced_at: iso(row.synced_at),
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
    account_name: row.account_name ?? null,
  };
}

export type OpportunityRow = {
  id: string;
  salesforce_id: string | null;
  account_id: string | null;
  name: string;
  stage: OpportunityStage;
  amount: string | number | null;
  close_date: TimestampLike;
  owner_name: string | null;
  probability: number | null;
  source: EntitySource;
  salesforce_updated_at: TimestampLike;
  synced_at: TimestampLike;
  created_at: TimestampLike;
  updated_at: TimestampLike;
  account_name?: string | null;
};

export function mapOpportunity(row: OpportunityRow): Opportunity {
  return {
    id: row.id,
    salesforce_id: row.salesforce_id,
    account_id: row.account_id,
    name: row.name,
    stage: row.stage,
    amount: numericString(row.amount),
    close_date: dateOnly(row.close_date),
    owner_name: textOrNull(row.owner_name),
    probability: intOrNull(row.probability),
    source: row.source,
    salesforce_updated_at: iso(row.salesforce_updated_at),
    synced_at: iso(row.synced_at),
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
    account_name: row.account_name ?? null,
  };
}

export type LeadRow = {
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
  consent: boolean | null;
  consent_at: TimestampLike;
  salesforce_updated_at: TimestampLike;
  synced_at: TimestampLike;
  created_at: TimestampLike;
  updated_at: TimestampLike;
};

export function mapLead(row: LeadRow): Lead {
  return {
    id: row.id,
    salesforce_id: row.salesforce_id,
    full_name: row.full_name,
    email: row.email,
    phone: textOrNull(row.phone),
    company: textOrNull(row.company),
    property_interest: textOrNull(row.property_interest),
    message: textOrNull(row.message),
    status: row.status,
    source: row.source,
    consent: row.consent === true,
    consent_at: iso(row.consent_at),
    salesforce_updated_at: iso(row.salesforce_updated_at),
    synced_at: iso(row.synced_at),
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
  };
}

export type SyncRunRow = {
  id: string;
  kind: SyncRunKind;
  status: SyncRunStatus;
  started_at: TimestampLike;
  finished_at: TimestampLike;
  records_read: number | string | null;
  records_written: number | string | null;
  error: string | null;
  details: unknown;
};

export function mapSyncRun(row: SyncRunRow): SyncRun {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    started_at: isoRequired(row.started_at),
    finished_at: iso(row.finished_at),
    records_read: intZero(row.records_read),
    records_written: intZero(row.records_written),
    error: row.error ?? null,
    details: row.details ?? null,
  };
}

export type CdcCheckpointRow = {
  channel: string;
  replay_id: string | number | bigint | null;
  last_event_at: TimestampLike;
  status: string;
  error: string | null;
  updated_at: TimestampLike;
};

/** Replay ids are 64-bit: always serialise as a string, never a JS number. */
export function bigintString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'bigint' ? value.toString() : String(value);
}

export function mapCheckpoint(row: CdcCheckpointRow): CdcCheckpoint {
  return {
    channel: row.channel,
    replay_id: bigintString(row.replay_id),
    last_event_at: iso(row.last_event_at),
    status: row.status,
    error: row.error ?? null,
    updated_at: isoRequired(row.updated_at),
  };
}

export type CdcEventRow = {
  id: string | number | bigint;
  event_id: string;
  channel: string;
  object_name: string;
  record_id: string;
  change_type: ChangeType;
  replay_id: string | number | bigint | null;
  payload: unknown;
  status: CdcEventStatus;
  error: string | null;
  latency_ms: number | null;
  received_at: TimestampLike;
  processed_at: TimestampLike;
};

export function mapCdcEvent(row: CdcEventRow): CdcEvent {
  return {
    id: bigintString(row.id) ?? '',
    event_id: row.event_id,
    channel: row.channel,
    object_name: row.object_name,
    record_id: row.record_id,
    change_type: row.change_type,
    replay_id: bigintString(row.replay_id),
    payload: row.payload ?? null,
    status: row.status,
    error: row.error ?? null,
    latency_ms: intOrNull(row.latency_ms),
    received_at: isoRequired(row.received_at),
    processed_at: iso(row.processed_at),
  };
}
