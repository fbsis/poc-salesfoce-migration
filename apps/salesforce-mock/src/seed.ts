/**
 * Default seed dataset (docs/CONTRACTS.md §6): a small real-estate agency.
 *
 * Ids use the real Salesforce key prefixes and the 15+3 checksum shape:
 *   001 = Account, 003 = Contact, 006 = Opportunity, 00Q = Lead, 005 = User,
 *   750 = Bulk API job.
 *
 * Stages cover the full OpportunityStage range and lead statuses use the
 * standard Salesforce picklist values (`Open - Not Contacted`,
 * `Working - Contacted`, `Qualified`), which the worker maps onto the CRM's
 * `LeadStatus` enum.
 */

import { SalesforceStore, type SfRecord, type DatasetCounts } from './store';

const SUFFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

/**
 * Builds an 18-char Salesforce id: 3-char key prefix + 12-char suffix (15)
 * + the 3-char case-checksum derived from the 15-char id.
 */
export function sfId(prefix: string, seq: number, marker = 'AAA'): string {
  const base = `${prefix}MOCK${String(seq).padStart(5, '0')}${marker}`.toUpperCase().slice(0, 15);
  let checksum = '';
  for (let chunk = 0; chunk < 3; chunk += 1) {
    let flags = 0;
    for (let pos = 0; pos < 5; pos += 1) {
      const char = base[chunk * 5 + pos];
      if (char >= 'A' && char <= 'Z') flags |= 1 << pos;
    }
    checksum += SUFFIX_ALPHABET[flags];
  }
  return base + checksum;
}

const USERS = {
  dana: sfId('005', 1),
  marcus: sfId('005', 2),
  priya: sfId('005', 3),
  sofia: sfId('005', 4),
};

function sfDate(value: string): string {
  return `${value}+0000`;
}

// ---------------------------------------------------------------- accounts

const ACCOUNTS: SfRecord[] = [
  {
    Id: sfId('001', 1),
    Name: 'Skyline Realty Group',
    Industry: 'Residential Real Estate',
    Type: 'Customer',
    Website: 'https://skyline-realty.example.com',
    Phone: '+1 415 555 0100',
    Description: 'Boutique residential brokerage covering the bay area.',
    BillingCountry: 'United States',
    OwnerId: USERS.dana,
    OwnerName: 'Dana Whitfield',
    CreatedDate: sfDate('2023-02-14T09:12:00.000'),
    LastModifiedDate: sfDate('2024-11-04T09:12:00.000'),
    SystemModstamp: sfDate('2024-11-04T09:12:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('001', 2),
    Name: 'Harbor Point Properties',
    Industry: 'Property Management',
    Type: 'Customer',
    Website: 'https://harborpoint.example.com',
    Phone: '+1 206 555 0188',
    Description: 'Manages 240 waterfront rental units.',
    BillingCountry: 'United States',
    OwnerId: USERS.marcus,
    OwnerName: 'Marcus Lee',
    CreatedDate: sfDate('2023-05-02T14:33:00.000'),
    LastModifiedDate: sfDate('2024-11-08T14:33:00.000'),
    SystemModstamp: sfDate('2024-11-08T14:33:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('001', 3),
    Name: 'Cedar & Grove Homes',
    Industry: 'Home Builder',
    Type: 'Customer',
    Website: 'https://cedarandgrove.example.com',
    Phone: '+1 512 555 0177',
    Description: 'Builds energy-efficient single-family homes.',
    BillingCountry: 'United States',
    OwnerId: USERS.priya,
    OwnerName: 'Priya Nair',
    CreatedDate: sfDate('2022-09-20T11:05:00.000'),
    LastModifiedDate: sfDate('2024-11-12T11:05:00.000'),
    SystemModstamp: sfDate('2024-11-12T11:05:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('001', 4),
    Name: 'Atlas Commercial Partners',
    Industry: 'Commercial Real Estate',
    Type: 'Partner',
    Website: 'https://atlas-commercial.example.com',
    Phone: '+1 646 555 0122',
    Description: 'Mixed-use development advisory and leasing.',
    BillingCountry: 'United States',
    OwnerId: USERS.sofia,
    OwnerName: 'Sofia Marchetti',
    CreatedDate: sfDate('2024-01-08T16:47:00.000'),
    LastModifiedDate: sfDate('2024-11-15T16:47:00.000'),
    SystemModstamp: sfDate('2024-11-15T16:47:00.000'),
    IsDeleted: false,
  },
];

// ---------------------------------------------------------------- contacts

const CONTACTS: SfRecord[] = [
  {
    Id: sfId('003', 1),
    FirstName: 'Elena',
    LastName: 'Marsh',
    Name: 'Elena Marsh',
    Email: 'elena.marsh@skyline-realty.example.com',
    Phone: '+1 415 555 0143',
    Title: 'Broker Associate',
    AccountId: sfId('001', 1),
    MailingCity: 'San Francisco',
    MailingCountry: 'United States',
    OwnerId: USERS.dana,
    OwnerName: 'Dana Whitfield',
    CreatedDate: sfDate('2023-03-01T10:20:00.000'),
    LastModifiedDate: sfDate('2024-11-05T08:40:00.000'),
    SystemModstamp: sfDate('2024-11-05T08:40:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('003', 2),
    FirstName: 'Tomás',
    LastName: 'Rivera',
    Name: 'Tomás Rivera',
    Email: 'tomas.rivera@skyline-realty.example.com',
    Phone: '+1 415 555 0155',
    Title: 'Listing Agent',
    AccountId: sfId('001', 1),
    MailingCity: 'Oakland',
    MailingCountry: 'United States',
    OwnerId: USERS.dana,
    OwnerName: 'Dana Whitfield',
    CreatedDate: sfDate('2023-04-11T13:15:00.000'),
    LastModifiedDate: sfDate('2024-11-09T10:05:00.000'),
    SystemModstamp: sfDate('2024-11-09T10:05:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('003', 3),
    FirstName: 'Grace',
    LastName: 'Okafor',
    Name: 'Grace Okafor',
    Email: 'grace.okafor@harborpoint.example.com',
    Phone: '+1 206 555 0191',
    Title: 'Property Manager',
    AccountId: sfId('001', 2),
    MailingCity: 'Seattle',
    MailingCountry: 'United States',
    OwnerId: USERS.marcus,
    OwnerName: 'Marcus Lee',
    CreatedDate: sfDate('2023-06-19T09:00:00.000'),
    LastModifiedDate: sfDate('2024-11-10T15:25:00.000'),
    SystemModstamp: sfDate('2024-11-10T15:25:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('003', 4),
    FirstName: 'Noah',
    LastName: 'Bennett',
    Name: 'Noah Bennett',
    Email: 'noah.bennett@cedarandgrove.example.com',
    Phone: '+1 512 555 0164',
    Title: 'Sales Manager',
    AccountId: sfId('001', 3),
    MailingCity: 'Austin',
    MailingCountry: 'United States',
    OwnerId: USERS.priya,
    OwnerName: 'Priya Nair',
    CreatedDate: sfDate('2022-10-03T08:30:00.000'),
    LastModifiedDate: sfDate('2024-11-13T12:00:00.000'),
    SystemModstamp: sfDate('2024-11-13T12:00:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('003', 5),
    FirstName: 'Hana',
    LastName: 'Sato',
    Name: 'Hana Sato',
    Email: 'hana.sato@atlas-commercial.example.com',
    Phone: '+1 646 555 0139',
    Title: 'Leasing Consultant',
    AccountId: sfId('001', 4),
    MailingCity: 'New York',
    MailingCountry: 'United States',
    OwnerId: USERS.sofia,
    OwnerName: 'Sofia Marchetti',
    CreatedDate: sfDate('2024-02-02T11:45:00.000'),
    LastModifiedDate: sfDate('2024-11-16T09:30:00.000'),
    SystemModstamp: sfDate('2024-11-16T09:30:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('003', 6),
    FirstName: 'Priya',
    LastName: 'Raman',
    Name: 'Priya Raman',
    Email: 'priya.raman@harborpoint.example.com',
    Phone: '+1 206 555 0156',
    Title: 'Leasing Coordinator',
    AccountId: sfId('001', 2),
    MailingCity: 'Tacoma',
    MailingCountry: 'United States',
    OwnerId: USERS.marcus,
    OwnerName: 'Marcus Lee',
    CreatedDate: sfDate('2023-08-07T10:10:00.000'),
    LastModifiedDate: sfDate('2024-11-14T17:10:00.000'),
    SystemModstamp: sfDate('2024-11-14T17:10:00.000'),
    IsDeleted: false,
  },
];

// ----------------------------------------------------------- opportunities

const OPPORTUNITIES: SfRecord[] = [
  {
    Id: sfId('006', 1),
    Name: 'Skyline – Downtown tower lease renewal',
    AccountId: sfId('001', 1),
    StageName: 'Prospecting',
    Amount: 480000,
    Probability: 10,
    CloseDate: '2025-01-31',
    Type: 'New Business',
    LeadSource: 'Partner Referral',
    Description: 'Renewal for floors 12-14 of the downtown tower.',
    OwnerId: USERS.dana,
    OwnerName: 'Dana Whitfield',
    IsClosed: false,
    IsWon: false,
    CreatedDate: sfDate('2024-10-01T09:00:00.000'),
    LastModifiedDate: sfDate('2024-11-06T09:45:00.000'),
    SystemModstamp: sfDate('2024-11-06T09:45:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('006', 2),
    Name: 'Harbor Point – 12-unit portfolio listing',
    AccountId: sfId('001', 2),
    StageName: 'Qualification',
    Amount: 265000,
    Probability: 25,
    CloseDate: '2025-02-14',
    Type: 'Existing Business',
    LeadSource: 'Web',
    Description: 'Listing mandate for the 12-unit waterfront portfolio.',
    OwnerId: USERS.marcus,
    OwnerName: 'Marcus Lee',
    IsClosed: false,
    IsWon: false,
    CreatedDate: sfDate('2024-10-08T14:20:00.000'),
    LastModifiedDate: sfDate('2024-11-08T11:10:00.000'),
    SystemModstamp: sfDate('2024-11-08T11:10:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('006', 3),
    Name: 'Cedar & Grove – Model home package',
    AccountId: sfId('001', 3),
    StageName: 'Proposal',
    Amount: 1250000,
    Probability: 55,
    CloseDate: '2025-03-15',
    Type: 'New Business',
    LeadSource: 'Trade Show',
    Description: 'Four furnished model homes for the Riverside community.',
    OwnerId: USERS.priya,
    OwnerName: 'Priya Nair',
    IsClosed: false,
    IsWon: false,
    CreatedDate: sfDate('2024-09-16T08:55:00.000'),
    LastModifiedDate: sfDate('2024-11-11T15:35:00.000'),
    SystemModstamp: sfDate('2024-11-11T15:35:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('006', 4),
    Name: 'Atlas – Mixed-use development advisory',
    AccountId: sfId('001', 4),
    StageName: 'Negotiation',
    Amount: 2400000,
    Probability: 70,
    CloseDate: '2025-04-30',
    Type: 'New Business',
    LeadSource: 'Partner Referral',
    Description: 'Advisory retainer for the waterfront mixed-use project.',
    OwnerId: USERS.sofia,
    OwnerName: 'Sofia Marchetti',
    IsClosed: false,
    IsWon: false,
    CreatedDate: sfDate('2024-08-21T13:05:00.000'),
    LastModifiedDate: sfDate('2024-11-15T16:50:00.000'),
    SystemModstamp: sfDate('2024-11-15T16:50:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('006', 5),
    Name: 'Skyline – Lakeside condos closing',
    AccountId: sfId('001', 1),
    StageName: 'Closed Won',
    Amount: 3150000,
    Probability: 100,
    CloseDate: '2024-10-18',
    Type: 'New Business',
    LeadSource: 'Web',
    Description: 'Sold the 18-unit Lakeside condominium block.',
    OwnerId: USERS.dana,
    OwnerName: 'Dana Whitfield',
    IsClosed: true,
    IsWon: true,
    CreatedDate: sfDate('2024-05-02T10:15:00.000'),
    LastModifiedDate: sfDate('2024-10-18T17:30:00.000'),
    SystemModstamp: sfDate('2024-10-18T17:30:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('006', 6),
    Name: 'Cedar & Grove – Riverside townhomes',
    AccountId: sfId('001', 3),
    StageName: 'Closed Lost',
    Amount: 890000,
    Probability: 0,
    CloseDate: '2024-09-30',
    Type: 'Existing Business',
    LeadSource: 'Cold Call',
    Description: 'Lost to a regional builder on price.',
    OwnerId: USERS.priya,
    OwnerName: 'Priya Nair',
    IsClosed: true,
    IsWon: false,
    CreatedDate: sfDate('2024-04-12T09:40:00.000'),
    LastModifiedDate: sfDate('2024-09-30T16:05:00.000'),
    SystemModstamp: sfDate('2024-09-30T16:05:00.000'),
    IsDeleted: false,
  },
];

// ------------------------------------------------------------------- leads

const LEADS: SfRecord[] = [
  {
    Id: sfId('00Q', 1),
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
    OwnerId: USERS.dana,
    OwnerName: 'Dana Whitfield',
    CreatedDate: sfDate('2024-11-14T10:05:00.000'),
    LastModifiedDate: sfDate('2024-11-14T10:05:00.000'),
    SystemModstamp: sfDate('2024-11-14T10:05:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('00Q', 2),
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
    OwnerId: USERS.priya,
    OwnerName: 'Priya Nair',
    CreatedDate: sfDate('2024-11-11T15:20:00.000'),
    LastModifiedDate: sfDate('2024-11-12T09:10:00.000'),
    SystemModstamp: sfDate('2024-11-12T09:10:00.000'),
    IsDeleted: false,
  },
  {
    Id: sfId('00Q', 3),
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
    OwnerId: USERS.marcus,
    OwnerName: 'Marcus Lee',
    CreatedDate: sfDate('2024-11-06T11:40:00.000'),
    LastModifiedDate: sfDate('2024-11-13T14:15:00.000'),
    SystemModstamp: sfDate('2024-11-13T14:15:00.000'),
    IsDeleted: false,
  },
];

export interface SeedDataset {
  accounts: SfRecord[];
  contacts: SfRecord[];
  opportunities: SfRecord[];
  leads: SfRecord[];
}

export function defaultDataset(): SeedDataset {
  return {
    accounts: ACCOUNTS.map((row) => ({ ...row })),
    contacts: CONTACTS.map((row) => ({ ...row })),
    opportunities: OPPORTUNITIES.map((row) => ({ ...row })),
    leads: LEADS.map((row) => ({ ...row })),
  };
}

/** Replaces the store contents with the default dataset and returns counts. */
export function seedStore(store: SalesforceStore): DatasetCounts {
  const dataset = defaultDataset();
  return store.replaceAll({
    Account: dataset.accounts,
    Contact: dataset.contacts,
    Opportunity: dataset.opportunities,
    Lead: dataset.leads,
  });
}

export const SEED_IDS = {
  users: USERS,
  accounts: {
    skyline: sfId('001', 1),
    harborPoint: sfId('001', 2),
    cedarGrove: sfId('001', 3),
    atlas: sfId('001', 4),
  },
  contacts: {
    elenaMarsh: sfId('003', 1),
    tomasRivera: sfId('003', 2),
    graceOkafor: sfId('003', 3),
    noahBennett: sfId('003', 4),
    hanaSato: sfId('003', 5),
    priyaRaman: sfId('003', 6),
  },
  opportunities: {
    skylineTower: sfId('006', 1),
    harborPortfolio: sfId('006', 2),
    cedarModelHomes: sfId('006', 3),
    atlasMixedUse: sfId('006', 4),
    skylineLakeside: sfId('006', 5),
    cedarRiverside: sfId('006', 6),
  },
  leads: {
    averySinclair: sfId('00Q', 1),
    diegoAlvarez: sfId('00Q', 2),
    miraChen: sfId('00Q', 3),
  },
} as const;
