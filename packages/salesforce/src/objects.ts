/**
 * SOQL field lists per object (docs/CONTRACTS.md §7) and the extraction order.
 *
 * Parents come first: Account → Contact → Opportunity → Lead, so the FK lookups
 * in `applySalesforceBatch` resolve on the first pass.
 */

export const OBJECT_NAMES = ['Account', 'Contact', 'Opportunity', 'Lead'] as const;
export type SalesforceObjectName = (typeof OBJECT_NAMES)[number];

export const OBJECT_FIELDS: Record<SalesforceObjectName, readonly string[]> = {
  Account: ['Id', 'Name', 'Industry', 'Website', 'BillingCountry', 'Owner.Name', 'SystemModstamp'],
  Contact: [
    'Id',
    'FirstName',
    'LastName',
    'Email',
    'Phone',
    'Title',
    'AccountId',
    'Owner.Name',
    'SystemModstamp',
  ],
  Opportunity: [
    'Id',
    'Name',
    'StageName',
    'Amount',
    'CloseDate',
    'Probability',
    'AccountId',
    'Owner.Name',
    'SystemModstamp',
  ],
  Lead: [
    'Id',
    'FirstName',
    'LastName',
    'Company',
    'Email',
    'Phone',
    'Status',
    'LeadSource',
    'Description',
    'SystemModstamp',
  ],
};

export function isSalesforceObjectName(value: string): value is SalesforceObjectName {
  return (OBJECT_NAMES as readonly string[]).includes(value);
}

export function fieldsFor(object: SalesforceObjectName): readonly string[] {
  return OBJECT_FIELDS[object];
}

/** `SELECT <fields> FROM <Object>` — the SOQL text uploaded to the bulk job. */
export function buildSoql(object: SalesforceObjectName, fields?: readonly string[]): string {
  const selected = (fields && fields.length > 0 ? fields : OBJECT_FIELDS[object]).join(', ');
  return `SELECT ${selected} FROM ${object}`;
}
