/**
 * The dataset `apps/worker/test/bulk.test.ts` seeds and asserts on.
 *
 * The mock is a single in-memory store shared by every suite (and by the demo
 * `worker` container), so this file owns its rows outright: it replaces the
 * dataset (`POST /mock/seed` without `mode`) and only ever reads back ids it
 * created here.
 *
 * Ids carry the `VITEST` marker right after the Salesforce key prefix, so the
 * suite-wide cleanup (`apps/web/test/global-setup.ts`) can find and delete them
 * without touching the `MOCK` demo rows.
 *
 * Shapes are deliberately small but real:
 *   4 accounts   → enough for the 2-row query-job page test to need 2+ pages
 *   2 contacts   → child rows, so the Account→Contact FK is exercised
 *   3 opport...  → one per Open/Proposal/Negotiation-style stage the CRM maps
 *   2 leads      → both mapped Salesforce statuses
 */

export interface BulkFixtureRecord {
  Id: string;
  [field: string]: unknown;
}

export interface BulkFixture {
  accounts: BulkFixtureRecord[];
  contacts: BulkFixtureRecord[];
  opportunities: BulkFixtureRecord[];
  leads: BulkFixtureRecord[];
}

/** `<prefix>VITESTBULK<tag>` padded to 15 chars + the 3-char checksum block. */
function bulkId(prefix: '001' | '003' | '006' | '00Q', tag: string): string {
  const base = `${prefix}VITESTBULK${tag}`.toUpperCase();
  return `${base.padEnd(15, 'X')}AAA`;
}

const ACCOUNT_IDS = ['A1', 'A2', 'A3', 'A4'].map((tag) => bulkId('001', tag));

const NOW = '2026-01-05T09:00:00.000+0000';

export const BULK_FIXTURE_IDS = {
  accounts: ACCOUNT_IDS,
  contacts: ['C1', 'C2'].map((tag) => bulkId('003', tag)),
  opportunities: ['O1', 'O2', 'O3'].map((tag) => bulkId('006', tag)),
  leads: ['L1', 'L2'].map((tag) => bulkId('00Q', tag)),
} as const;

/** Postgres `LIKE` prefix of every id this fixture creates. */
export const BULK_ID_PREFIX = 'VITESTBULK';

/** Rows in the fixture — the mock's whole dataset once it is seeded. */
export const BULK_FIXTURE_COUNTS = {
  accounts: ACCOUNT_IDS.length,
  contacts: BULK_FIXTURE_IDS.contacts.length,
  opportunities: BULK_FIXTURE_IDS.opportunities.length,
  leads: BULK_FIXTURE_IDS.leads.length,
} as const;

export const BULK_FIXTURE_RECORD_COUNT =
  BULK_FIXTURE_COUNTS.accounts +
  BULK_FIXTURE_COUNTS.contacts +
  BULK_FIXTURE_COUNTS.opportunities +
  BULK_FIXTURE_COUNTS.leads;

/** A fresh copy; `/mock/seed` and the extract may mutate what they are given. */
export function bulkFixture(): BulkFixture {
  const accounts: BulkFixtureRecord[] = ACCOUNT_IDS.map((Id, index) => ({
    Id,
    Name: `VITEST Bulk Account ${index + 1}`,
    Industry: ['Residential Real Estate', 'Property Management', 'Home Builder', 'Commercial Real Estate'][
      index
    ],
    Type: index === 3 ? 'Partner' : 'Customer',
    Website: `https://vitest-bulk-${index + 1}.example.test`,
    BillingCountry: 'United States',
    OwnerName: 'Dana Whitfield',
    CreatedDate: NOW,
    LastModifiedDate: NOW,
    SystemModstamp: NOW,
    IsDeleted: false,
  }));

  const contacts: BulkFixtureRecord[] = BULK_FIXTURE_IDS.contacts.map((Id, index) => ({
    Id,
    AccountId: ACCOUNT_IDS[index],
    FirstName: ['Vera', 'Nils'][index],
    LastName: `VITEST Bulk Contact ${index + 1}`,
    Email: `vitest-bulk-contact-${index + 1}@example.test`,
    Title: ['Broker Associate', 'Leasing Manager'][index],
    LastModifiedDate: NOW,
    SystemModstamp: NOW,
    IsDeleted: false,
  }));

  const opportunities: BulkFixtureRecord[] = BULK_FIXTURE_IDS.opportunities.map((Id, index) => ({
    Id,
    AccountId: ACCOUNT_IDS[index],
    Name: `VITEST Bulk Opportunity ${index + 1}`,
    StageName: ['Prospecting', 'Proposal', 'Negotiation'][index],
    Amount: [120_000, 240_000, 360_000][index],
    CloseDate: '2026-06-30',
    Probability: [10, 60, 80][index],
    OwnerName: 'Dana Whitfield',
    LastModifiedDate: NOW,
    SystemModstamp: NOW,
    IsDeleted: false,
  }));

  const leads: BulkFixtureRecord[] = BULK_FIXTURE_IDS.leads.map((Id, index) => ({
    Id,
    FirstName: 'VITEST',
    LastName: `Bulk Lead ${index + 1}`,
    Company: `VITEST Bulk Company ${index + 1}`,
    Email: `vitest-bulk-lead-${index + 1}@example.test`,
    Status: ['Open - Not Contacted', 'Working - Contacted'][index],
    LeadSource: 'Web',
    LastModifiedDate: NOW,
    SystemModstamp: NOW,
    IsDeleted: false,
  }));

  return { accounts, contacts, opportunities, leads };
}
