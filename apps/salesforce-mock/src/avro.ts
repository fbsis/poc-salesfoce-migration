/**
 * Avro schemas for Salesforce CDC change events (Account, Contact,
 * Opportunity, Lead) plus encoding helpers used by the gRPC Pub/Sub server
 * and by the smoke test.
 *
 * Shape (docs/CONTRACTS.md §6):
 *   { ChangeEventHeader: {...}, ...object fields }
 *
 * `ChangeEventHeader` carries exactly the fields listed in the contract:
 * entityName, recordIds, changeType, changedFields, changeOrigin,
 * transactionKey, sequenceNumber, commitTimestamp, commitNumber, commitUser,
 * nulledFields, diffFields, isTransactionEnd.
 *
 * Payload convention for this mock: every object field is nullable (union
 * ["null", <type>] with default null) and an event carries the *full record
 * snapshot*, not only the changed fields, so the consumer can rebuild a row
 * without a follow-up query. `changedFields` / `nulledFields` / `diffFields`
 * in the header still describe what actually changed.
 */

import { createHash } from 'node:crypto';
import avro from 'avsc';
import type { SfObject, StoredEvent } from './store';

type FieldKind = 'string' | 'date' | 'double' | 'int' | 'boolean' | 'owner';

interface FieldDef {
  name: string;
  kind: FieldKind;
}

const CHANGE_TYPE_SYMBOLS = ['CREATE', 'UPDATE', 'DELETE', 'UNDELETE'] as const;

const OBJECT_FIELDS: Record<SfObject, FieldDef[]> = {
  Account: [
    { name: 'Name', kind: 'string' },
    { name: 'Phone', kind: 'string' },
    { name: 'Website', kind: 'string' },
    { name: 'Industry', kind: 'string' },
    { name: 'Type', kind: 'string' },
    { name: 'Description', kind: 'string' },
    { name: 'BillingCountry', kind: 'string' },
    { name: 'OwnerId', kind: 'string' },
    { name: 'Owner', kind: 'owner' },
    { name: 'CreatedDate', kind: 'date' },
    { name: 'CreatedById', kind: 'string' },
    { name: 'LastModifiedDate', kind: 'date' },
    { name: 'LastModifiedById', kind: 'string' },
    { name: 'SystemModstamp', kind: 'date' },
    { name: 'IsDeleted', kind: 'boolean' },
  ],
  Contact: [
    { name: 'FirstName', kind: 'string' },
    { name: 'LastName', kind: 'string' },
    { name: 'Name', kind: 'string' },
    { name: 'Email', kind: 'string' },
    { name: 'Phone', kind: 'string' },
    { name: 'Title', kind: 'string' },
    { name: 'AccountId', kind: 'string' },
    { name: 'MailingCity', kind: 'string' },
    { name: 'MailingCountry', kind: 'string' },
    { name: 'OwnerId', kind: 'string' },
    { name: 'Owner', kind: 'owner' },
    { name: 'CreatedDate', kind: 'date' },
    { name: 'LastModifiedDate', kind: 'date' },
    { name: 'SystemModstamp', kind: 'date' },
    { name: 'IsDeleted', kind: 'boolean' },
  ],
  Opportunity: [
    { name: 'Name', kind: 'string' },
    { name: 'AccountId', kind: 'string' },
    { name: 'StageName', kind: 'string' },
    { name: 'Amount', kind: 'double' },
    { name: 'Probability', kind: 'int' },
    { name: 'CloseDate', kind: 'date' },
    { name: 'Type', kind: 'string' },
    { name: 'LeadSource', kind: 'string' },
    { name: 'Description', kind: 'string' },
    { name: 'OwnerId', kind: 'string' },
    { name: 'Owner', kind: 'owner' },
    { name: 'IsClosed', kind: 'boolean' },
    { name: 'IsWon', kind: 'boolean' },
    { name: 'CreatedDate', kind: 'date' },
    { name: 'LastModifiedDate', kind: 'date' },
    { name: 'SystemModstamp', kind: 'date' },
    { name: 'IsDeleted', kind: 'boolean' },
  ],
  Lead: [
    { name: 'FirstName', kind: 'string' },
    { name: 'LastName', kind: 'string' },
    { name: 'Name', kind: 'string' },
    { name: 'Company', kind: 'string' },
    { name: 'Email', kind: 'string' },
    { name: 'Phone', kind: 'string' },
    { name: 'Status', kind: 'string' },
    { name: 'LeadSource', kind: 'string' },
    { name: 'City', kind: 'string' },
    { name: 'Country', kind: 'string' },
    { name: 'Description', kind: 'string' },
    { name: 'Property_Interest__c', kind: 'string' },
    { name: 'OwnerId', kind: 'string' },
    { name: 'Owner', kind: 'owner' },
    { name: 'CreatedDate', kind: 'date' },
    { name: 'LastModifiedDate', kind: 'date' },
    { name: 'SystemModstamp', kind: 'date' },
    { name: 'IsDeleted', kind: 'boolean' },
  ],
};

export interface SchemaEntry {
  object: SfObject;
  schemaId: string;
  schemaJson: string;
  type: avro.Type;
}

function avroTypeForField(object: SfObject, field: FieldDef): unknown {
  switch (field.kind) {
    case 'double':
      return ['null', 'double'];
    case 'int':
      return ['null', 'int'];
    case 'boolean':
      return ['null', 'boolean'];
    case 'owner':
      return [
        'null',
        {
          type: 'record',
          name: 'Owner',
          fields: [{ name: 'Name', type: ['null', 'string'], default: null }],
        },
      ];
    case 'date':
    case 'string':
    default:
      return ['null', 'string'];
  }
}

function buildSchemaJson(object: SfObject): Record<string, unknown> {
  return {
    type: 'record',
    name: `${object}ChangeEvent`,
    namespace: `mock.salesforce.cdc.${object.toLowerCase()}`,
    doc: `Mock Salesforce CDC event for ${object}`,
    fields: [
      {
        name: 'ChangeEventHeader',
        type: {
          type: 'record',
          name: 'ChangeEventHeader',
          fields: [
            { name: 'entityName', type: 'string' },
            { name: 'recordIds', type: { type: 'array', items: 'string' } },
            {
              name: 'changeType',
              type: { type: 'enum', name: 'ChangeType', symbols: [...CHANGE_TYPE_SYMBOLS] },
            },
            { name: 'changedFields', type: { type: 'array', items: 'string' }, default: [] },
            { name: 'changeOrigin', type: 'string' },
            { name: 'transactionKey', type: 'string' },
            { name: 'sequenceNumber', type: 'long' },
            { name: 'commitTimestamp', type: 'long' },
            { name: 'commitNumber', type: 'long' },
            { name: 'commitUser', type: 'string' },
            { name: 'nulledFields', type: { type: 'array', items: 'string' }, default: [] },
            { name: 'diffFields', type: { type: 'array', items: 'string' }, default: [] },
            { name: 'isTransactionEnd', type: 'boolean', default: false },
          ],
        },
      },
      ...OBJECT_FIELDS[object].map((field) => ({
        name: field.name,
        type: avroTypeForField(object, field),
        default: null,
      })),
    ],
  };
}

function buildEntry(object: SfObject): SchemaEntry {
  const schemaJson = buildSchemaJson(object);
  const schemaText = JSON.stringify(schemaJson);
  const schemaId = createHash('sha256').update(schemaText).digest('hex');
  const type = avro.Type.forSchema(schemaJson as unknown as avro.Schema);
  return { object, schemaId, schemaJson: schemaText, type };
}

export const SCHEMAS: Record<SfObject, SchemaEntry> = {
  Account: buildEntry('Account'),
  Contact: buildEntry('Contact'),
  Opportunity: buildEntry('Opportunity'),
  Lead: buildEntry('Lead'),
};

export function getSchemaForObject(object: SfObject): SchemaEntry {
  return SCHEMAS[object];
}

export function findSchemaById(schemaId: string): SchemaEntry | null {
  if (!schemaId) return null;
  return Object.values(SCHEMAS).find((entry) => entry.schemaId === schemaId) ?? null;
}

// ------------------------------------------------------------ datum helpers

function asString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' ? value : String(value);
}

function asDouble(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

function asInt(value: unknown): number | null {
  const num = asDouble(value);
  return num === null ? null : Math.round(num);
}

function asBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no'].includes(text)) return false;
  return null;
}

function ownerDatum(record: Record<string, unknown>): { Name: string | null } | null {
  const direct = record.OwnerName ?? record['Owner.Name'];
  if (typeof direct === 'string' && direct.length > 0) return { Name: direct };
  const nested = record.Owner;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const name = (nested as Record<string, unknown>).Name;
    if (typeof name === 'string') return { Name: name };
  }
  return null;
}

function fieldDatum(field: FieldDef, record: Record<string, unknown>): unknown {
  switch (field.kind) {
    case 'owner':
      return ownerDatum(record);
    case 'double':
      return asDouble(record[field.name]);
    case 'int':
      return asInt(record[field.name]);
    case 'boolean':
      return asBoolean(record[field.name]);
    case 'date':
    case 'string':
    default:
      return asString(record[field.name]);
  }
}

export interface ChangeEventHeaderDatum {
  entityName: string;
  recordIds: string[];
  changeType: string;
  changedFields: string[];
  changeOrigin: string;
  transactionKey: string;
  sequenceNumber: number;
  commitTimestamp: number;
  commitNumber: number;
  commitUser: string;
  nulledFields: string[];
  diffFields: string[];
  isTransactionEnd: boolean;
}

export function headerFromEvent(event: StoredEvent): ChangeEventHeaderDatum {
  return {
    entityName: event.object,
    recordIds: [...event.recordIds],
    changeType: event.changeType,
    changedFields: [...event.changedFields],
    changeOrigin: event.changeOrigin,
    transactionKey: event.transactionKey,
    sequenceNumber: event.sequenceNumber,
    commitTimestamp: event.commitTimestamp,
    commitNumber: event.commitNumber,
    commitUser: event.commitUser,
    nulledFields: [...event.nulledFields],
    diffFields: [...event.diffFields],
    isTransactionEnd: true,
  };
}

/** Full avro datum (header + object fields) for a stored event. */
export function datumForEvent(event: StoredEvent): Record<string, unknown> {
  const datum: Record<string, unknown> = { ChangeEventHeader: headerFromEvent(event) };
  for (const field of OBJECT_FIELDS[event.object]) {
    datum[field.name] = fieldDatum(field, event.record as Record<string, unknown>);
  }
  return datum;
}

/** Avro binary payload for a stored event (what goes into `ConsumerEvent.event.payload`). */
export function encodeChangeEvent(event: StoredEvent): Buffer {
  return getSchemaForObject(event.object).type.toBuffer(datumForEvent(event));
}

export interface DecodedChangeEvent {
  ChangeEventHeader: ChangeEventHeaderDatum;
  [field: string]: unknown;
}

export function decodeChangeEvent(
  object: SfObject,
  payload: Buffer | Uint8Array | string,
): DecodedChangeEvent {
  const buf =
    typeof payload === 'string' ? Buffer.from(payload, 'binary') : Buffer.from(payload);
  return getSchemaForObject(object).type.fromBuffer(buf) as DecodedChangeEvent;
}
