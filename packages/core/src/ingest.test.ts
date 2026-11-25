import { afterAll, describe, expect, it } from 'vitest';
import { getAccount } from './accounts';
import { getContact } from './contacts';
import { closePool, query, queryOne } from './db';
import {
  applySalesforceBatch,
  applySalesforceRecord,
  deleteSalesforceRecord,
  linkOrphanRecords,
  normaliseObject,
  type ApplyResult,
} from './ingest';
import { getLead } from './leads';
import { getOpportunity } from './opportunities';

const run = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
// 18-char alphanumeric Salesforce ids: 3-char key prefix + generated body.
const body = run.replace(/[^a-zA-Z0-9]/g, '').padEnd(15, 'X').slice(-15);
const sfid = (prefix: string, suffix: string | number) =>
  `${prefix}${suffix.toString().replace(/[^a-zA-Z0-9]/g, '')}${body}`
    .slice(0, 18)
    .padEnd(18, 'X');

const createdIds: string[] = [];

function track(result: ApplyResult): ApplyResult {
  if (result.id) createdIds.push(result.id);
  return result;
}

async function findAccount(salesforceId: string) {
  return queryOne<{
    id: string;
    name: string;
    industry: string | null;
    owner_name: string | null;
    source: string;
    salesforce_updated_at: Date | null;
    synced_at: Date | null;
  }>(`SELECT id, name, industry, owner_name, source, salesforce_updated_at, synced_at
        FROM accounts WHERE salesforce_id = $1`, [salesforceId]);
}

async function findContact(salesforceId: string) {
  return queryOne<{
    id: string;
    account_id: string | null;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    title: string | null;
    source: string;
  }>(`SELECT id, account_id, first_name, last_name, email, phone, title, source
        FROM contacts WHERE salesforce_id = $1`, [salesforceId]);
}

async function countBySalesforceId(table: string, salesforceId: string): Promise<number> {
  const row = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM ${table} WHERE salesforce_id = $1`,
    [salesforceId],
  );
  return row?.total ?? 0;
}

afterAll(async () => {
  if (createdIds.length > 0) {
    for (const table of ['contacts', 'opportunities', 'leads', 'accounts'] as const) {
      await query(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [createdIds]);
    }
  }
  try {
    await linkOrphanRecords();
  } catch {
    // The orphan table is created on demand; nothing to prune in this run.
  }
  await closePool();
});

describe('salesforce ingest', () => {
  it('normalises object names', () => {
    expect(normaliseObject('Account')).toBe('account');
    expect(normaliseObject('AccountChangeEvent')).toBe('account');
    expect(normaliseObject('opportunitychangeevent')).toBe('opportunity');
    expect(normaliseObject('Lead')).toBe('lead');
    expect(normaliseObject('Case')).toBe('unknown');
  });

  it('upserts idempotently by salesforce_id', async () => {
    const id = sfid('001', 'idem');
    const record = {
      Id: id,
      Name: `Vitest SF ${id}`,
      Industry: 'Energy',
      'Owner.Name': 'Ada Lovelace',
      SystemModstamp: '2025-01-01T10:00:00.000+0000',
    };

    const first = track(await applySalesforceRecord('Account', 'CREATE', record));
    expect(first.outcome).toBe('applied');
    expect(first.entity).toBe('account');
    expect(first.id).toBeTruthy();

    const second = track(await applySalesforceRecord('Account', 'CREATE', record));
    expect(second.outcome).toBe('applied');
    expect(second.id).toBe(first.id);

    expect(await countBySalesforceId('accounts', id)).toBe(1);
    const row = await findAccount(id);
    expect(row?.source).toBe('salesforce');
    expect(row?.industry).toBe('Energy');
    expect(row?.owner_name).toBe('Ada Lovelace');
    expect(row?.synced_at).not.toBeNull();
    expect(row?.salesforce_updated_at?.toISOString()).toBe('2025-01-01T10:00:00.000Z');
  });

  it('skips a stale record and keeps the newer row (guard is in SQL)', async () => {
    const id = sfid('001', 'stale');
    track(
      await applySalesforceRecord('Account', 'CREATE', {
        Id: id,
        Name: 'Newer name',
        SystemModstamp: '2025-02-01T00:00:00Z',
      }),
    );

    const stale = await applySalesforceRecord('Account', 'UPDATE', {
      Id: id,
      Name: 'Older name',
      SystemModstamp: '2025-01-01T00:00:00Z',
    });
    expect(stale.outcome).toBe('skipped_stale');
    expect(stale.id).toBeNull();
    expect((await findAccount(id))?.name).toBe('Newer name');

    // Same timestamp = idempotent replay, still writes.
    const replay = track(
      await applySalesforceRecord('Account', 'UPDATE', {
        Id: id,
        Name: 'Replayed name',
        SystemModstamp: '2025-02-01T00:00:00Z',
      }),
    );
    expect(replay.outcome).toBe('applied');
    expect((await findAccount(id))?.name).toBe('Replayed name');
  });

  it('falls back to LastModifiedDate when SystemModstamp is absent', async () => {
    const id = sfid('001', 'lastmod');
    track(
      await applySalesforceRecord('Account', 'CREATE', {
        Id: id,
        Name: 'First',
        LastModifiedDate: '2025-03-01T00:00:00.000Z',
      }),
    );
    const stale = await applySalesforceRecord('Account', 'UPDATE', {
      Id: id,
      Name: 'Second',
      LastModifiedDate: '2025-02-01T00:00:00.000Z',
    });
    expect(stale.outcome).toBe('skipped_stale');
    expect((await findAccount(id))?.name).toBe('First');
  });

  it('treats CREATE, UPDATE and UNDELETE as upsert and DELETE as delete', async () => {
    const id = sfid('001', 'changes');
    track(await applySalesforceRecord('Account', 'CREATE', { Id: id, Name: 'Created' }));
    track(
      await applySalesforceRecord('Account', 'UPDATE', {
        Id: id,
        Name: 'Updated',
        SystemModstamp: '2025-01-01T00:00:00Z',
      }),
    );
    expect((await findAccount(id))?.name).toBe('Updated');

    track(await applySalesforceRecord('Account', 'UNDELETE', { Id: id, Name: 'Undeleted' }));
    expect((await findAccount(id))?.name).toBe('Undeleted');

    const deleted = await deleteSalesforceRecord('Account', id);
    expect(deleted.outcome).toBe('applied');
    expect(deleted.reason).toBe('deleted');
    expect(await countBySalesforceId('accounts', id)).toBe(0);

    const again = await deleteSalesforceRecord('Account', id);
    expect(again.outcome).toBe('ignored');
    expect(again.id).toBeNull();

    // applySalesforceRecord delegates DELETE to deleteSalesforceRecord.
    const viaApply = await applySalesforceRecord('Account', 'DELETE', { Id: id });
    expect(viaApply.outcome).toBe('ignored');
    expect(viaApply.entity).toBe('account');
  });

  it('ignores unsupported objects and records without an Id', async () => {
    expect((await applySalesforceRecord('Case', 'CREATE', { Id: sfid('500', 'x') })).outcome).toBe(
      'ignored',
    );
    const missing = await applySalesforceRecord('Account', 'CREATE', {} as never);
    expect(missing.outcome).toBe('ignored');
    expect(missing.reason).toMatch(/Id/);
  });

  it('does not blank fields that the update does not carry', async () => {
    const id = sfid('003', 'partial');
    track(
      await applySalesforceRecord('Contact', 'CREATE', {
        Id: id,
        FirstName: 'Grace',
        LastName: 'Hopper',
        Email: 'Grace@Example.COM',
        Phone: '111',
        SystemModstamp: '2025-01-01T00:00:00Z',
      }),
    );
    let row = await findContact(id);
    expect(row?.email).toBe('grace@example.com');
    expect(row?.first_name).toBe('Grace');

    // A CDC-style partial update: only Phone is present.
    track(
      await applySalesforceRecord('Contact', 'UPDATE', {
        Id: id,
        Phone: '222',
        SystemModstamp: '2025-01-02T00:00:00Z',
      }),
    );
    row = await findContact(id);
    expect(row?.phone).toBe('222');
    expect(row?.first_name).toBe('Grace');
    expect(row?.last_name).toBe('Hopper');
    expect(row?.email).toBe('grace@example.com');

    // nulledFields: an explicit null clears the column.
    track(
      await applySalesforceRecord('Contact', 'UPDATE', {
        Id: id,
        Phone: null,
        SystemModstamp: '2025-01-03T00:00:00Z',
      }),
    );
    expect((await findContact(id))?.phone).toBeNull();
  });

  it('stores an orphan contact/opportunity as NULL and re-links it later', async () => {
    const accountSf = sfid('001', 'parent');
    const contactSf = sfid('003', 'orphan');
    const opportunitySf = sfid('006', 'orphan');

    track(
      await applySalesforceRecord('Contact', 'CREATE', {
        Id: contactSf,
        FirstName: 'Orphan',
        LastName: 'Contact',
        AccountId: accountSf,
        SystemModstamp: '2025-01-01T00:00:00Z',
      }),
    );
    track(
      await applySalesforceRecord('Opportunity', 'CREATE', {
        Id: opportunitySf,
        Name: 'Orphan Deal',
        AccountId: accountSf,
        SystemModstamp: '2025-01-01T00:00:00Z',
      }),
    );

    expect((await findContact(contactSf))?.account_id).toBeNull();
    const opportunity = await queryOne<{ account_id: string | null }>(
      `SELECT account_id FROM opportunities WHERE salesforce_id = $1`,
      [opportunitySf],
    );
    expect(opportunity?.account_id).toBeNull();

    // Nothing to resolve yet (the parent account is still unknown).
    const before = await linkOrphanRecords();
    expect(before.contacts).toBeGreaterThanOrEqual(0);

    const account = track(
      await applySalesforceRecord('Account', 'CREATE', {
        Id: accountSf,
        Name: 'Parent Account',
        SystemModstamp: '2025-01-01T00:00:00Z',
      }),
    );
    expect(account.id).toBeTruthy();

    const linked = await linkOrphanRecords();
    expect(linked.contacts).toBeGreaterThanOrEqual(1);
    expect(linked.opportunities).toBeGreaterThanOrEqual(1);

    expect((await findContact(contactSf))?.account_id).toBe(account.id);
    const relinked = await getOpportunity(opportunitySf);
    expect(relinked.account_id).toBe(account.id);
    expect((await getContact(contactSf)).account_name).toBe('Parent Account');
  });

  it('applies a batch and re-links orphans at the end', async () => {
    const accountSf = sfid('001', 'batchparent');
    const contactSf = sfid('003', 'batchorphan');

    track(
      await applySalesforceRecord('Contact', 'CREATE', {
        Id: contactSf,
        LastName: 'BatchOrphan',
        AccountId: accountSf,
      }),
    );
    expect((await findContact(contactSf))?.account_id).toBeNull();

    const batch = await applySalesforceBatch('Account', 'CREATE', [
      { Id: accountSf, Name: 'Batch Parent', SystemModstamp: '2025-01-01T00:00:00Z' },
      { Id: sfid('001', 'batch2'), Name: 'Batch Two', SystemModstamp: '2025-01-01T00:00:00Z' },
    ]);
    expect(batch).toEqual({ applied: 2, skipped_stale: 0, ignored: 0, errors: [] });

    for (const id of [accountSf, sfid('001', 'batch2')]) {
      const row = await findAccount(id);
      if (row) createdIds.push(row.id);
    }

    // The orphan was re-linked by the batch itself.
    const contact = await findContact(contactSf);
    expect(contact?.account_id).not.toBeNull();

    const staleBatch = await applySalesforceBatch('Account', 'UPDATE', [
      { Id: accountSf, Name: 'Old', SystemModstamp: '2024-01-01T00:00:00Z' },
      { Id: sfid('001', 'batch2'), Name: 'Old', SystemModstamp: '2024-01-01T00:00:00Z' },
    ]);
    expect(staleBatch.applied).toBe(0);
    expect(staleBatch.skipped_stale).toBe(2);
  });

  it('maps opportunity fields including nested Owner and date/amount formats', async () => {
    const accountSf = sfid('001', 'oppaccount');
    const account = track(
      await applySalesforceRecord('Account', 'CREATE', {
        Id: accountSf,
        Name: 'Opportunity Account',
        SystemModstamp: '2025-01-01T00:00:00Z',
      }),
    );

    const opportunitySf = sfid('006', 'mapped');
    track(
      await applySalesforceRecord('Opportunity', 'CREATE', {
        Id: opportunitySf,
        Name: 'Mapped Deal',
        AccountId: accountSf,
        StageName: 'Proposal',
        Amount: '12345.5',
        CloseDate: '2025-04-01',
        Probability: 40.6,
        Owner: { attributes: { type: 'User' }, Name: 'Nested Owner' },
        SystemModstamp: '2025-01-01T00:00:00Z',
      }),
    );

    const opportunity = await getOpportunity(opportunitySf);
    expect(opportunity.account_id).toBe(account.id);
    expect(opportunity.stage).toBe('Proposal');
    expect(opportunity.amount).toBe('12345.50');
    expect(opportunity.close_date).toBe('2025-04-01');
    expect(opportunity.probability).toBe(41);
    expect(opportunity.owner_name).toBe('Nested Owner');
    expect(opportunity.source).toBe('salesforce');
  });

  it('maps lead fields and Salesforce lead statuses', async () => {
    const leadSf = sfid('00Q', 'mapped');
    track(
      await applySalesforceRecord('Lead', 'CREATE', {
        Id: leadSf,
        FirstName: 'Alan',
        LastName: 'Turing',
        Email: 'Alan.Turing@Example.COM',
        Company: 'Bletchley',
        Description: 'Met at conference',
        Status: 'Open - Not Contacted',
        SystemModstamp: '2025-01-01T00:00:00Z',
      }),
    );

    const lead = await getLead(leadSf);
    expect(lead.full_name).toBe('Alan Turing');
    expect(lead.email).toBe('alan.turing@example.com');
    expect(lead.company).toBe('Bletchley');
    expect(lead.message).toBe('Met at conference');
    expect(lead.status).toBe('new');
    expect(lead.source).toBe('salesforce');

    track(
      await applySalesforceRecord('Lead', 'UPDATE', {
        Id: leadSf,
        Status: 'Closed - Converted',
        SystemModstamp: '2025-01-02T00:00:00Z',
      }),
    );
    expect((await getLead(leadSf)).status).toBe('closed');
  });

  it('never regresses a row under concurrent writes', async () => {
    const id = sfid('001', 'race');
    track(
      await applySalesforceRecord('Account', 'CREATE', {
        Id: id,
        Name: 'Race base',
        SystemModstamp: '2025-01-01T00:00:00Z',
      }),
    );

    // Fire an older and a newer snapshot at the same row simultaneously. Whichever
    // order Postgres serialises them in, the newer content must win.
    const [older, newer] = await Promise.all([
      applySalesforceRecord('Account', 'UPDATE', {
        Id: id,
        Name: 'Race older',
        SystemModstamp: '2024-12-01T00:00:00Z',
      }),
      applySalesforceRecord('Account', 'UPDATE', {
        Id: id,
        Name: 'Race newer',
        SystemModstamp: '2025-06-01T00:00:00Z',
      }),
    ]);

    expect(['applied', 'skipped_stale']).toContain(older.outcome);
    expect(newer.outcome).toBe('applied');
    expect((await findAccount(id))?.name).toBe('Race newer');
  });

  it('accepts ChangeEvent-shaped object names', async () => {
    const id = sfid('001', 'changeevent');
    const result = track(
      await applySalesforceRecord('AccountChangeEvent', 'UPDATE', {
        Id: id,
        Name: 'From CDC',
        ChangeEventHeader: { entityName: 'Account', changeType: 'UPDATE', commitTimestamp: 1_735_000_000_000 },
      }),
    );
    expect(result.outcome).toBe('applied');
    const row = await findAccount(id);
    expect(row?.name).toBe('From CDC');
    expect(row?.salesforce_updated_at?.toISOString()).toBe(new Date(1_735_000_000_000).toISOString());
    expect((await getAccount(id)).id).toBe(result.id);
  });
});
