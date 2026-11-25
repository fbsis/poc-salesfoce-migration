/**
 * Id discrimination. Services accept "uuid or salesforce id" for lookups
 * (docs/CONTRACTS.md §3); the two families are distinguishable by shape.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Salesforce ids are 15 or 18 alphanumeric characters with a 3-char key prefix
// (Account = 001, Contact = 003, Opportunity = 006, Lead = 00Q).
const SALESFORCE_ID_RE = /^[a-zA-Z0-9]{15}$|^[a-zA-Z0-9]{18}$/;

export type IdKind = 'uuid' | 'salesforce' | 'unknown';

export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

export function isSalesforceId(value: unknown): boolean {
  return typeof value === 'string' && SALESFORCE_ID_RE.test(value.trim());
}

export function classifyId(value: unknown): IdKind {
  if (isUuid(value)) return 'uuid';
  if (isSalesforceId(value)) return 'salesforce';
  return 'unknown';
}

/** Salesforce key prefixes, useful for sanity checks (not used to reject). */
export const SALESFORCE_PREFIX = {
  account: '001',
  contact: '003',
  opportunity: '006',
  lead: '00Q',
} as const;
