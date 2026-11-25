import { afterAll, describe, expect, it } from 'vitest';
import { createAccount } from './accounts';
import { closePool, query } from './db';
import {
  createOpportunity,
  getOpportunity,
  listOpportunities,
  updateOpportunity,
} from './opportunities';

const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prefix = `vitest-opps-${run}`;
const createdOpportunityIds: string[] = [];
const createdAccountIds: string[] = [];

afterAll(async () => {
  if (createdOpportunityIds.length > 0) {
    await query(`DELETE FROM opportunities WHERE id = ANY($1::uuid[])`, [createdOpportunityIds]);
  }
  if (createdAccountIds.length > 0) {
    await query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [createdAccountIds]);
  }
  await closePool();
});

async function makeAccount(label: string) {
  const account = await createAccount({ name: `${prefix}-${label}` });
  createdAccountIds.push(account.id);
  return account;
}

describe('opportunities service', () => {
  it('creates an opportunity with defaults and a string amount', async () => {
    const opportunity = await createOpportunity({ name: `${prefix}-defaults` });
    createdOpportunityIds.push(opportunity.id);

    expect(opportunity.stage).toBe('Prospecting');
    expect(opportunity.amount).toBe('0.00');
    expect(typeof opportunity.amount).toBe('string');
    expect(opportunity.close_date).toBeNull();
    expect(opportunity.probability).toBeNull();
    expect(opportunity.source).toBe('local');
    expect(opportunity.account_id).toBeNull();
  });

  it('stores amount/date/probability and returns them in contract shapes', async () => {
    const account = await makeAccount('deals');
    const opportunity = await createOpportunity({
      name: `${prefix}-big-deal`,
      account_id: account.id,
      stage: 'Negotiation',
      amount: '150000.5',
      close_date: '2025-03-31',
      owner_name: 'Ada Lovelace',
      probability: 65,
    });
    createdOpportunityIds.push(opportunity.id);

    expect(opportunity.amount).toBe('150000.50');
    expect(opportunity.close_date).toBe('2025-03-31');
    expect(opportunity.probability).toBe(65);
    expect(opportunity.stage).toBe('Negotiation');
    expect(opportunity.account_name).toBe(account.name);

    const fetched = await getOpportunity(opportunity.id);
    expect(fetched).toEqual(opportunity);
  });

  it('validates stage, amount and close_date', async () => {
    await expect(createOpportunity({ name: 'x', stage: 'Nope' as never })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(createOpportunity({ name: 'x', amount: -5 })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(
      createOpportunity({ name: 'x', amount: '1.234' as unknown as number }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(createOpportunity({ name: 'x', close_date: '31/03/2025' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(createOpportunity({ name: 'x', probability: 101 })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('filters by stage and account, with pagination', async () => {
    const account = await makeAccount('filter');
    for (const [name, stage] of [
      ['one', 'Proposal'],
      ['two', 'Proposal'],
      ['three', 'Qualification'],
    ] as const) {
      const opportunity = await createOpportunity({
        name: `${prefix}-filter-${name}`,
        account_id: account.id,
        stage,
        amount: 10,
      });
      createdOpportunityIds.push(opportunity.id);
    }

    const proposals = await listOpportunities({ search: `${prefix}-filter-`, stage: 'Proposal' });
    expect(proposals.total).toBe(2);
    expect(proposals.data.every((row) => row.stage === 'Proposal')).toBe(true);

    const byAccount = await listOpportunities({ account_id: account.id });
    expect(byAccount.total).toBe(3);

    const page = await listOpportunities({
      search: `${prefix}-filter-`,
      limit: 2,
      offset: 2,
    });
    expect(page.total).toBe(3);
    expect(page.data).toHaveLength(1);

    await expect(listOpportunities({ stage: 'Bogus' as never })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('updates fields and reports not_found', async () => {
    const opportunity = await createOpportunity({
      name: `${prefix}-update`,
      amount: 100,
      close_date: '2025-01-01',
    });
    createdOpportunityIds.push(opportunity.id);

    const updated = await updateOpportunity(opportunity.id, {
      stage: 'Closed Won',
      amount: 250.25,
      close_date: null,
      probability: null,
    });
    expect(updated.stage).toBe('Closed Won');
    expect(updated.amount).toBe('250.25');
    expect(updated.close_date).toBeNull();

    await expect(
      updateOpportunity('00000000-0000-4000-8000-000000000000', { name: 'ghost' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(getOpportunity('not-an-id')).rejects.toMatchObject({ code: 'not_found' });
  });
});
