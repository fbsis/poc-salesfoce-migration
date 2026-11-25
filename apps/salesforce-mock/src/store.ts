/**
 * In-memory Salesforce dataset + CDC event ring buffer.
 *
 * Everything the mock serves is derived from this module: the Bulk API 2.0
 * query jobs, the SOQL endpoint, the Pub/Sub stream and the /mock/* admin
 * endpoints all read from the same store.
 *
 * Ordering guarantees (see docs/CONTRACTS.md §6):
 *  - `commitTimestamp` is monotonically increasing (ms epoch, strictly
 *    increasing even if two events land in the same millisecond).
 *  - `commitNumber` increases once per emitted event (global transaction-ish
 *    counter, exported as `ChangeEventHeader.commitNumber`).
 *  - `sequenceNumber` increases per *record* (one counter per Salesforce id).
 *  - `replayId` is a single global monotonically increasing counter; a replay
 *    id is never reused, even after `/mock/reset` and ring-buffer eviction.
 */

import { randomUUID } from 'node:crypto';

export const SF_OBJECTS = ['Account', 'Contact', 'Opportunity', 'Lead'] as const;
export type SfObject = (typeof SF_OBJECTS)[number];

export const CHANGE_TYPES = ['CREATE', 'UPDATE', 'DELETE', 'UNDELETE'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export const RING_BUFFER_SIZE = 1000;

/** Mock internal user id (18-char Salesforce user id shape). */
export const DEFAULT_COMMIT_USER = '005MOCK000000001AAA';

/** Salesforce-shaped record: `Id` + flat field values. */
export interface SfRecord {
  Id: string;
  [field: string]: unknown;
}

export interface EmitInput {
  object: SfObject;
  changeType: ChangeType;
  record: SfRecord;
  /** Optional explicit change list; computed by diffing when omitted. */
  changedFields?: string[];
  commitUser?: string;
}

export interface StoredEvent {
  /** 1-based, monotonically increasing; encoded as 8-byte big-endian long. */
  replayId: number;
  object: SfObject;
  topic: string;
  changeType: ChangeType;
  recordIds: string[];
  changedFields: string[];
  nulledFields: string[];
  diffFields: string[];
  /** ms epoch, strictly increasing. */
  commitTimestamp: number;
  commitNumber: number;
  /** per-record increasing counter. */
  sequenceNumber: number;
  commitUser: string;
  transactionKey: string;
  changeOrigin: string;
  /** Full record snapshot *after* the change (Salesforce field names). */
  record: SfRecord;
  emittedAt: string;
}

export interface PublishResult {
  delivered: number;
  queued: boolean;
}

export type EventPublisher = (event: StoredEvent) => PublishResult;

export interface DatasetCounts {
  accounts: number;
  contacts: number;
  opportunities: number;
  leads: number;
}

export type DatasetInput = Partial<Record<SfObject, SfRecord[]>>;

export const PLURAL: Record<SfObject, keyof DatasetCounts> = {
  Account: 'accounts',
  Contact: 'contacts',
  Opportunity: 'opportunities',
  Lead: 'leads',
};

export const PLURAL_TO_OBJECT: Record<keyof DatasetCounts, SfObject> = {
  accounts: 'Account',
  contacts: 'Contact',
  opportunities: 'Opportunity',
  leads: 'Lead',
};

const ID_FIELDS = new Set(['Id']);

// ---------------------------------------------------------------- utilities

export function isSfObject(value: unknown): value is SfObject {
  return typeof value === 'string' && (SF_OBJECTS as readonly string[]).includes(value);
}

export function toObjectName(value: string): SfObject | null {
  const wanted = value.trim().toLowerCase();
  const hit = SF_OBJECTS.find((object) => object.toLowerCase() === wanted);
  return hit ?? null;
}

export function isChangeType(value: unknown): value is ChangeType {
  return typeof value === 'string' && (CHANGE_TYPES as readonly string[]).includes(value);
}

export function topicForObject(object: SfObject): string {
  return `/data/${object}ChangeEvent`;
}

/** `/data/AccountChangeEvent`, `AccountChangeEvent`, `/data/Account_ChangeEvent`. */
export function objectFromTopic(topic: string): SfObject | null {
  const match = /([A-Za-z]+)_?ChangeEvent$/.exec(topic.trim());
  if (!match) return null;
  return toObjectName(match[1]);
}

/** Salesforce datetime format: `2024-11-01T09:15:00.000+0000`. */
export function toSfDateTime(date: Date): string {
  return date.toISOString().replace('Z', '+0000');
}

export function parseSfDate(value: unknown): number {
  if (value === null || value === undefined || value === '') return Number.NaN;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  let text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(`${text}T00:00:00.000Z`);
  text = text.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  if (!/[zZ]$|[+-]\d{2}:\d{2}$/.test(text)) text += 'Z';
  return Date.parse(text);
}

/** Replay ids are the 8-byte big-endian representation of a signed long. */
export function encodeReplayId(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(Math.trunc(value)));
  return buf;
}

export function decodeReplayId(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
  if (buf.length === 0) return 0;
  if (buf.length === 8) return Number(buf.readBigInt64BE(0));
  let total = 0;
  for (const byte of buf) total = total * 256 + byte;
  return total;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Normalise an incoming Salesforce-shaped record:
 *  - drops `attributes`
 *  - flattens `Owner: { Name }` to `OwnerName` (the seed/emit convenience form)
 *  - derives compound `Name` for Contact/Lead when absent
 */
export function normalizeRecord(object: SfObject, input: Record<string, unknown>): SfRecord {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'attributes' || value === undefined) continue;
    out[key] = value;
  }
  const owner = out.Owner;
  if (owner && typeof owner === 'object' && !Array.isArray(owner)) {
    const ownerRecord = owner as Record<string, unknown>;
    if (typeof ownerRecord.Name === 'string') out.OwnerName = ownerRecord.Name;
  }
  delete out.Owner;
  if (object === 'Contact' || object === 'Lead') {
    const compound = [out.FirstName, out.LastName]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean)
      .join(' ');
    if (typeof out.Name !== 'string' || out.Name.trim() === '') out.Name = compound;
  }
  return out as SfRecord;
}

/**
 * Internal convenience keys that are not Salesforce field names; CDC headers
 * must expose the Salesforce spelling (`Owner.Name`, not `OwnerName`).
 */
const FIELD_ALIASES: Record<string, string> = { OwnerName: 'Owner.Name' };

function toSalesforceFieldNames(fields: string[]): string[] {
  const mapped = fields.map((field) => FIELD_ALIASES[field] ?? field);
  return [...new Set(mapped)];
}

// -------------------------------------------------------------------- store

export class SalesforceStore {
  private records: Record<SfObject, Map<string, SfRecord>> = {
    Account: new Map(),
    Contact: new Map(),
    Opportunity: new Map(),
    Lead: new Map(),
  };

  private buffer: StoredEvent[] = [];
  private recordSequences = new Map<string, number>();
  /**
   * Seeded from wall-clock so replay ids keep increasing across process
   * restarts: a worker checkpoint persisted in Postgres before `docker compose
   * restart salesforce-mock` is still below every id issued afterwards, so
   * CUSTOM replay resumes correctly instead of silently stalling.
   * (Date.now() * 1000 ≈ 1.8e15, well inside Number.MAX_SAFE_INTEGER.)
   */
  private replayCounter = Date.now() * 1000;
  private commitCounter = 0;
  private lastCommitTimestamp = 0;
  private publisher: EventPublisher | null = null;

  setPublisher(publisher: EventPublisher | null): void {
    this.publisher = publisher;
  }

  // ------------------------------------------------------------- dataset IO

  list(object: SfObject): SfRecord[] {
    return [...this.records[object].values()];
  }

  getRecord(object: SfObject, id: string): SfRecord | null {
    return this.records[object].get(id) ?? null;
  }

  counts(): DatasetCounts {
    return {
      accounts: this.records.Account.size,
      contacts: this.records.Contact.size,
      opportunities: this.records.Opportunity.size,
      leads: this.records.Lead.size,
    };
  }

  snapshot(): { data: Record<keyof DatasetCounts, SfRecord[]>; counts: DatasetCounts } {
    return {
      data: {
        accounts: this.list('Account'),
        contacts: this.list('Contact'),
        opportunities: this.list('Opportunity'),
        leads: this.list('Lead'),
      },
      counts: this.counts(),
    };
  }

  /** Replace the whole dataset (missing objects become empty). */
  replaceAll(input: DatasetInput): DatasetCounts {
    for (const object of SF_OBJECTS) {
      const rows = input[object] ?? [];
      const map = new Map<string, SfRecord>();
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const normalized = normalizeRecord(object, row as Record<string, unknown>);
        const id = typeof normalized.Id === 'string' ? normalized.Id : String(normalized.Id ?? '');
        if (!id) continue;
        normalized.Id = id;
        if (typeof normalized.IsDeleted !== 'boolean') normalized.IsDeleted = false;
        map.set(id, normalized);
      }
      this.records[object] = map;
    }
    return this.counts();
  }

  /** Clears dataset + event log. Replay ids keep increasing (never reused). */
  clear(): void {
    for (const object of SF_OBJECTS) this.records[object] = new Map();
    this.buffer = [];
    this.recordSequences.clear();
  }

  // -------------------------------------------------------------- event log

  get latestReplayId(): number {
    return this.replayCounter;
  }

  get latestCommitNumber(): number {
    return this.commitCounter;
  }

  get oldestReplayId(): number {
    return this.buffer.length > 0 ? this.buffer[0].replayId : this.latestReplayId + 1;
  }

  allEvents(): StoredEvent[] {
    return [...this.buffer];
  }

  /** Buffered events with `replayId > after`. */
  eventsAfter(after: number): StoredEvent[] {
    if (this.buffer.length === 0) return [];
    return this.buffer.filter((event) => event.replayId > after);
  }

  private nextCommitTimestamp(): number {
    const now = Date.now();
    this.lastCommitTimestamp = Math.max(now, this.lastCommitTimestamp + 1);
    return this.lastCommitTimestamp;
  }

  private pushEvent(event: StoredEvent): void {
    this.buffer.push(event);
    while (this.buffer.length > RING_BUFFER_SIZE) this.buffer.shift();
  }

  // ------------------------------------------------------------------ emit

  /**
   * Applies a change to the dataset and appends the matching CDC event.
   * CREATE/UPDATE/UNDELETE upsert the record (UPDATE merges over the previous
   * snapshot, so explicit `null` values null a field); DELETE keeps the record
   * with `IsDeleted = true` and removes it from default query results.
   */
  emit(input: EmitInput): { event: StoredEvent; delivered: number; queued: boolean } {
    if (!isSfObject(input.object)) throw new Error(`Unsupported object: ${String(input.object)}`);
    if (!isChangeType(input.changeType)) {
      throw new Error(`Unsupported changeType: ${String(input.changeType)}`);
    }
    const incoming = input.record;
    if (!incoming || typeof incoming !== 'object' || incoming.Id === undefined || incoming.Id === null) {
      throw new Error('record.Id is required');
    }

    const object = input.object;
    const id = String(incoming.Id);
    const existing = this.records[object].get(id) ?? null;
    const now = new Date();
    const normalized = normalizeRecord(object, incoming as Record<string, unknown>);

    let next: SfRecord;
    if (input.changeType === 'DELETE') {
      next = { ...(existing ?? normalized), Id: id } as SfRecord;
      next.IsDeleted = true;
    } else {
      next = { ...(existing ?? {}), ...normalized, Id: id } as SfRecord;
      if (typeof next.IsDeleted !== 'boolean') next.IsDeleted = false;
      if (input.changeType === 'UNDELETE') next.IsDeleted = false;
    }
    if (!next.CreatedDate) next.CreatedDate = toSfDateTime(now);
    next.LastModifiedDate = toSfDateTime(now);
    next.SystemModstamp = toSfDateTime(now);

    // changed / nulled / diff field lists -----------------------------------
    let changedFields: string[];
    if (input.changedFields && input.changedFields.length > 0) {
      changedFields = toSalesforceFieldNames(input.changedFields.map((field) => String(field)));
    } else if (input.changeType === 'DELETE') {
      changedFields = [];
    } else if (input.changeType === 'CREATE') {
      changedFields = Object.keys(next).filter(
        (key) => !ID_FIELDS.has(key) && next[key] !== null && next[key] !== undefined,
      );
    } else {
      changedFields = Object.keys(next).filter(
        (key) => !ID_FIELDS.has(key) && !deepEqual(next[key], existing?.[key]),
      );
    }
    const nulledFields =
      input.changeType === 'DELETE'
        ? []
        : toSalesforceFieldNames(
            Object.keys(next).filter(
              (key) =>
                !ID_FIELDS.has(key) &&
                next[key] === null &&
                existing !== null &&
                existing[key] !== undefined &&
                existing[key] !== null,
            ),
          );
    changedFields = toSalesforceFieldNames(changedFields);
    const diffFields = input.changeType === 'UPDATE' ? [...changedFields] : [];

    const replayId = ++this.replayCounter;
    const seqKey = `${object}:${id}`;
    const sequenceNumber = (this.recordSequences.get(seqKey) ?? 0) + 1;
    this.recordSequences.set(seqKey, sequenceNumber);

    const event: StoredEvent = {
      replayId,
      object,
      topic: topicForObject(object),
      changeType: input.changeType,
      recordIds: [id],
      changedFields,
      nulledFields,
      diffFields,
      commitTimestamp: this.nextCommitTimestamp(),
      commitNumber: ++this.commitCounter,
      sequenceNumber,
      commitUser: input.commitUser ?? DEFAULT_COMMIT_USER,
      transactionKey: `mock-${replayId}-${randomUUID().slice(0, 8)}`,
      changeOrigin: 'mock',
      record: { ...next },
      emittedAt: new Date().toISOString(),
    };

    this.records[object].set(id, next);
    this.pushEvent(event);

    const published = this.publisher ? this.publisher(event) : { delivered: 0, queued: false };
    return { event, delivered: published.delivered, queued: published.queued };
  }
}
