/**
 * The canonical demo dataset, in the mock's own Salesforce shape.
 *
 * This mirrors `apps/salesforce-mock/src/seed.ts` (`defaultDataset()`): 4
 * accounts, 6 contacts, 6 opportunities and 3 leads — the dataset docs/DEMO.md
 * documents (`"dataset":{"accounts":4,"contacts":6,"opportunities":6,"leads":3}`).
 *
 * Why a copy instead of an import: the fixture lives in the test workspace and
 * must not depend on another app's source tree, and the mock's dataset is only
 * reachable over HTTP (there is no endpoint that serves its *default* dataset).
 * The copy is verified at restore time: `apps/web/test/global-setup.ts` seeds it
 * and then fails the run unless `/mock/health` reports `CANONICAL_COUNTS`.
 *
 * Do not edit a value here to make an assertion pass — fix the mock's seed
 * instead, then re-sync this file.
 */

export interface CanonicalRecord {
  Id: string;
  [field: string]: unknown;
}

export interface CanonicalDataset {
  accounts: CanonicalRecord[];
  contacts: CanonicalRecord[];
  opportunities: CanonicalRecord[];
  leads: CanonicalRecord[];
}

export const CANONICAL_COUNTS = {
  accounts: 4,
  contacts: 6,
  opportunities: 6,
  leads: 3,
} as const;

/** The 19 rows docs/DEMO.md expects the mock to hold after a reset. */
export const CANONICAL_RECORD_COUNT = 19;

const DATASET: CanonicalDataset = {
  accounts: [
    {
      Id: '001MOCK00001AAAYD2',
      Name: 'Skyline Realty Group',
      Industry: 'Residential Real Estate',
      Type: 'Customer',
      Website: 'https://skyline-realty.example.com',
      Phone: '+1 415 555 0100',
      Description: 'Boutique residential brokerage covering the bay area.',
      BillingCountry: 'United States',
      OwnerId: '005MOCK00001AAAYD2',
      OwnerName: 'Dana Whitfield',
      CreatedDate: '2023-02-14T09:12:00.000+0000',
      LastModifiedDate: '2024-11-04T09:12:00.000+0000',
      SystemModstamp: '2024-11-04T09:12:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '001MOCK00002AAAYD2',
      Name: 'Harbor Point Properties',
      Industry: 'Property Management',
      Type: 'Customer',
      Website: 'https://harborpoint.example.com',
      Phone: '+1 206 555 0188',
      Description: 'Manages 240 waterfront rental units.',
      BillingCountry: 'United States',
      OwnerId: '005MOCK00002AAAYD2',
      OwnerName: 'Marcus Lee',
      CreatedDate: '2023-05-02T14:33:00.000+0000',
      LastModifiedDate: '2024-11-08T14:33:00.000+0000',
      SystemModstamp: '2024-11-08T14:33:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '001MOCK00003AAAYD2',
      Name: 'Cedar & Grove Homes',
      Industry: 'Home Builder',
      Type: 'Customer',
      Website: 'https://cedarandgrove.example.com',
      Phone: '+1 512 555 0177',
      Description: 'Builds energy-efficient single-family homes.',
      BillingCountry: 'United States',
      OwnerId: '005MOCK00003AAAYD2',
      OwnerName: 'Priya Nair',
      CreatedDate: '2022-09-20T11:05:00.000+0000',
      LastModifiedDate: '2024-11-12T11:05:00.000+0000',
      SystemModstamp: '2024-11-12T11:05:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '001MOCK00004AAAYD2',
      Name: 'Atlas Commercial Partners',
      Industry: 'Commercial Real Estate',
      Type: 'Partner',
      Website: 'https://atlas-commercial.example.com',
      Phone: '+1 646 555 0122',
      Description: 'Mixed-use development advisory and leasing.',
      BillingCountry: 'United States',
      OwnerId: '005MOCK00004AAAYD2',
      OwnerName: 'Sofia Marchetti',
      CreatedDate: '2024-01-08T16:47:00.000+0000',
      LastModifiedDate: '2024-11-15T16:47:00.000+0000',
      SystemModstamp: '2024-11-15T16:47:00.000+0000',
      IsDeleted: false
    }
  ],
  contacts: [
    {
      Id: '003MOCK00001AAAYD2',
      FirstName: 'Elena',
      LastName: 'Marsh',
      Name: 'Elena Marsh',
      Email: 'elena.marsh@skyline-realty.example.com',
      Phone: '+1 415 555 0143',
      Title: 'Broker Associate',
      AccountId: '001MOCK00001AAAYD2',
      MailingCity: 'San Francisco',
      MailingCountry: 'United States',
      OwnerId: '005MOCK00001AAAYD2',
      OwnerName: 'Dana Whitfield',
      CreatedDate: '2023-03-01T10:20:00.000+0000',
      LastModifiedDate: '2024-11-05T08:40:00.000+0000',
      SystemModstamp: '2024-11-05T08:40:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '003MOCK00002AAAYD2',
      FirstName: 'Tomás',
      LastName: 'Rivera',
      Name: 'Tomás Rivera',
      Email: 'tomas.rivera@skyline-realty.example.com',
      Phone: '+1 415 555 0155',
      Title: 'Listing Agent',
      AccountId: '001MOCK00001AAAYD2',
      MailingCity: 'Oakland',
      MailingCountry: 'United States',
      OwnerId: '005MOCK00001AAAYD2',
      OwnerName: 'Dana Whitfield',
      CreatedDate: '2023-04-11T13:15:00.000+0000',
      LastModifiedDate: '2024-11-09T10:05:00.000+0000',
      SystemModstamp: '2024-11-09T10:05:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '003MOCK00003AAAYD2',
      FirstName: 'Grace',
      LastName: 'Okafor',
      Name: 'Grace Okafor',
      Email: 'grace.okafor@harborpoint.example.com',
      Phone: '+1 206 555 0191',
      Title: 'Property Manager',
      AccountId: '001MOCK00002AAAYD2',
      MailingCity: 'Seattle',
      MailingCountry: 'United States',
      OwnerId: '005MOCK00002AAAYD2',
      OwnerName: 'Marcus Lee',
      CreatedDate: '2023-06-19T09:00:00.000+0000',
      LastModifiedDate: '2024-11-10T15:25:00.000+0000',
      SystemModstamp: '2024-11-10T15:25:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '003MOCK00004AAAYD2',
      FirstName: 'Noah',
      LastName: 'Bennett',
      Name: 'Noah Bennett',
      Email: 'noah.bennett@cedarandgrove.example.com',
      Phone: '+1 512 555 0164',
      Title: 'Sales Manager',
      AccountId: '001MOCK00003AAAYD2',
      MailingCity: 'Austin',
      MailingCountry: 'United States',
      OwnerId: '005MOCK00003AAAYD2',
      OwnerName: 'Priya Nair',
      CreatedDate: '2022-10-03T08:30:00.000+0000',
      LastModifiedDate: '2024-11-13T12:00:00.000+0000',
      SystemModstamp: '2024-11-13T12:00:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '003MOCK00005AAAYD2',
      FirstName: 'Hana',
      LastName: 'Sato',
      Name: 'Hana Sato',
      Email: 'hana.sato@atlas-commercial.example.com',
      Phone: '+1 646 555 0139',
      Title: 'Leasing Consultant',
      AccountId: '001MOCK00004AAAYD2',
      MailingCity: 'New York',
      MailingCountry: 'United States',
      OwnerId: '005MOCK00004AAAYD2',
      OwnerName: 'Sofia Marchetti',
      CreatedDate: '2024-02-02T11:45:00.000+0000',
      LastModifiedDate: '2024-11-16T09:30:00.000+0000',
      SystemModstamp: '2024-11-16T09:30:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '003MOCK00006AAAYD2',
      FirstName: 'Priya',
      LastName: 'Raman',
      Name: 'Priya Raman',
      Email: 'priya.raman@harborpoint.example.com',
      Phone: '+1 206 555 0156',
      Title: 'Leasing Coordinator',
      AccountId: '001MOCK00002AAAYD2',
      MailingCity: 'Tacoma',
      MailingCountry: 'United States',
      OwnerId: '005MOCK00002AAAYD2',
      OwnerName: 'Marcus Lee',
      CreatedDate: '2023-08-07T10:10:00.000+0000',
      LastModifiedDate: '2024-11-14T17:10:00.000+0000',
      SystemModstamp: '2024-11-14T17:10:00.000+0000',
      IsDeleted: false
    }
  ],
  opportunities: [
    {
      Id: '006MOCK00001AAAYD2',
      Name: 'Skyline – Downtown tower lease renewal',
      AccountId: '001MOCK00001AAAYD2',
      StageName: 'Prospecting',
      Amount: 480000,
      Probability: 10,
      CloseDate: '2025-01-31',
      Type: 'New Business',
      LeadSource: 'Partner Referral',
      Description: 'Renewal for floors 12-14 of the downtown tower.',
      OwnerId: '005MOCK00001AAAYD2',
      OwnerName: 'Dana Whitfield',
      IsClosed: false,
      IsWon: false,
      CreatedDate: '2024-10-01T09:00:00.000+0000',
      LastModifiedDate: '2024-11-06T09:45:00.000+0000',
      SystemModstamp: '2024-11-06T09:45:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '006MOCK00002AAAYD2',
      Name: 'Harbor Point – 12-unit portfolio listing',
      AccountId: '001MOCK00002AAAYD2',
      StageName: 'Qualification',
      Amount: 265000,
      Probability: 25,
      CloseDate: '2025-02-14',
      Type: 'Existing Business',
      LeadSource: 'Web',
      Description: 'Listing mandate for the 12-unit waterfront portfolio.',
      OwnerId: '005MOCK00002AAAYD2',
      OwnerName: 'Marcus Lee',
      IsClosed: false,
      IsWon: false,
      CreatedDate: '2024-10-08T14:20:00.000+0000',
      LastModifiedDate: '2024-11-08T11:10:00.000+0000',
      SystemModstamp: '2024-11-08T11:10:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '006MOCK00003AAAYD2',
      Name: 'Cedar & Grove – Model home package',
      AccountId: '001MOCK00003AAAYD2',
      StageName: 'Proposal',
      Amount: 1250000,
      Probability: 55,
      CloseDate: '2025-03-15',
      Type: 'New Business',
      LeadSource: 'Trade Show',
      Description: 'Four furnished model homes for the Riverside community.',
      OwnerId: '005MOCK00003AAAYD2',
      OwnerName: 'Priya Nair',
      IsClosed: false,
      IsWon: false,
      CreatedDate: '2024-09-16T08:55:00.000+0000',
      LastModifiedDate: '2024-11-11T15:35:00.000+0000',
      SystemModstamp: '2024-11-11T15:35:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '006MOCK00004AAAYD2',
      Name: 'Atlas – Mixed-use development advisory',
      AccountId: '001MOCK00004AAAYD2',
      StageName: 'Negotiation',
      Amount: 2400000,
      Probability: 70,
      CloseDate: '2025-04-30',
      Type: 'New Business',
      LeadSource: 'Partner Referral',
      Description: 'Advisory retainer for the waterfront mixed-use project.',
      OwnerId: '005MOCK00004AAAYD2',
      OwnerName: 'Sofia Marchetti',
      IsClosed: false,
      IsWon: false,
      CreatedDate: '2024-08-21T13:05:00.000+0000',
      LastModifiedDate: '2024-11-15T16:50:00.000+0000',
      SystemModstamp: '2024-11-15T16:50:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '006MOCK00005AAAYD2',
      Name: 'Skyline – Lakeside condos closing',
      AccountId: '001MOCK00001AAAYD2',
      StageName: 'Closed Won',
      Amount: 3150000,
      Probability: 100,
      CloseDate: '2024-10-18',
      Type: 'New Business',
      LeadSource: 'Web',
      Description: 'Sold the 18-unit Lakeside condominium block.',
      OwnerId: '005MOCK00001AAAYD2',
      OwnerName: 'Dana Whitfield',
      IsClosed: true,
      IsWon: true,
      CreatedDate: '2024-05-02T10:15:00.000+0000',
      LastModifiedDate: '2024-10-18T17:30:00.000+0000',
      SystemModstamp: '2024-10-18T17:30:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '006MOCK00006AAAYD2',
      Name: 'Cedar & Grove – Riverside townhomes',
      AccountId: '001MOCK00003AAAYD2',
      StageName: 'Closed Lost',
      Amount: 890000,
      Probability: 0,
      CloseDate: '2024-09-30',
      Type: 'Existing Business',
      LeadSource: 'Cold Call',
      Description: 'Lost to a regional builder on price.',
      OwnerId: '005MOCK00003AAAYD2',
      OwnerName: 'Priya Nair',
      IsClosed: true,
      IsWon: false,
      CreatedDate: '2024-04-12T09:40:00.000+0000',
      LastModifiedDate: '2024-09-30T16:05:00.000+0000',
      SystemModstamp: '2024-09-30T16:05:00.000+0000',
      IsDeleted: false
    }
  ],
  leads: [
    {
      Id: '00QMOCK00001AAA2D2',
      FirstName: 'Avery',
      LastName: 'Sinclair',
      Name: 'Avery Sinclair',
      Company: 'Sinclair Holdings',
      Email: 'avery.sinclair@sinclair-holdings.example.com',
      Phone: '+1 415 555 0210',
      Status: 'Open - Not Contacted',
      LeadSource: 'Web',
      City: 'San Francisco',
      Country: 'United States',
      Property_Interest__c: '3-bedroom waterfront condo in Harbor Point',
      Description: 'Downloaded the Harbor Point brochure; wants a weekend viewing.',
      OwnerId: '005MOCK00001AAAYD2',
      OwnerName: 'Dana Whitfield',
      CreatedDate: '2024-11-14T10:05:00.000+0000',
      LastModifiedDate: '2024-11-14T10:05:00.000+0000',
      SystemModstamp: '2024-11-14T10:05:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '00QMOCK00002AAA2D2',
      FirstName: 'Diego',
      LastName: 'Álvarez',
      Name: 'Diego Álvarez',
      Company: 'Álvarez Rentals',
      Email: 'diego.alvarez@alvarez-rentals.example.com',
      Phone: '+1 512 555 0244',
      Status: 'Working - Contacted',
      LeadSource: 'Phone Inquiry',
      City: 'Austin',
      Country: 'United States',
      Property_Interest__c: 'Multi-family investment property, 6-10 units',
      Description: 'Called about cap rates for the Riverside townhomes.',
      OwnerId: '005MOCK00003AAAYD2',
      OwnerName: 'Priya Nair',
      CreatedDate: '2024-11-11T15:20:00.000+0000',
      LastModifiedDate: '2024-11-12T09:10:00.000+0000',
      SystemModstamp: '2024-11-12T09:10:00.000+0000',
      IsDeleted: false
    },
    {
      Id: '00QMOCK00003AAA2D2',
      FirstName: 'Mira',
      LastName: 'Chen',
      Name: 'Mira Chen',
      Company: 'Northgate Living',
      Email: 'mira.chen@northgate-living.example.com',
      Phone: '+1 206 555 0287',
      Status: 'Qualified',
      LeadSource: 'Partner Referral',
      City: 'Seattle',
      Country: 'United States',
      Property_Interest__c: 'Downtown loft, 2 bedrooms, move-in ready',
      Description: 'Referred by Harbor Point; pre-approved for financing.',
      OwnerId: '005MOCK00002AAAYD2',
      OwnerName: 'Marcus Lee',
      CreatedDate: '2024-11-06T11:40:00.000+0000',
      LastModifiedDate: '2024-11-13T14:15:00.000+0000',
      SystemModstamp: '2024-11-13T14:15:00.000+0000',
      IsDeleted: false
    }
  ],
};

/**
 * A pristine copy of the canonical dataset.
 *
 * Deep-copied per call: `/mock/seed` normalises and mutates what it is given
 * (it adds `OwnerName`/`Name`, `IsDeleted`), and a test must never be able to
 * change the fixture for the next caller.
 */
export function canonicalDataset(): CanonicalDataset {
  const copy = (rows: CanonicalRecord[]) => rows.map((row) => ({ ...row }));
  return {
    accounts: copy(DATASET.accounts),
    contacts: copy(DATASET.contacts),
    opportunities: copy(DATASET.opportunities),
    leads: copy(DATASET.leads),
  };
}

/**
 * Id markers owned by the test suite. Every fixture row the suite creates puts
 * one of these right after the 3-char Salesforce key prefix, so the cleanup can
 * find *test* rows in the mock and in Postgres without touching demo rows:
 *
 *   E2E ids      `001E2E<6 hex><tag>AAA`  (apps/web/test/e2e/helpers.ts)
 *   worker ids   `006VITEST…`, `001VITESTBULK…` (apps/worker/test)
 *
 * `~` in Postgres and `new RegExp` here both read it as a POSIX/JS regex.
 */
export const TEST_ID_REGEX = '(E2E[0-9A-F]{6}|VITEST|TEST)';

/** Landing-page leads created by the suite (`e2e-<run>-<label>@example.test`). */
export const TEST_LEAD_EMAIL_PATTERN = 'e2e-%@example.test';
