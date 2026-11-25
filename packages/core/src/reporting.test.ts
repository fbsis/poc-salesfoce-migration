import { afterAll, describe, expect, it } from 'vitest';
import { createAccount } from './accounts';
import { closePool, query } from './db';
import { applySalesforceRecord, deleteSalesforceRecord, linkOrphanRecords } from './ingest';
import { createLead } from './leads';
import { createOpportunity } from './opportunities';
import {
  getLeadSummary,
  getOpportunitiesByStage,
  getSalesSummary,
  getSyncStatus,
} from './reporting';
import { listCdcEvents, markCdcEventProcessed, recordCdcEvent } from './sync';
import type { OpportunityStage } from './types';

const run = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
const prefix = `vitest-reporting-${run}`;
const body = run.replace(/[^a-zA-Z0-9]/g, '').padEnd(15, 'X').slice(-15);
const sfid = (p: string, s: string) => `${p}${s}${body}`.slice(0, 18).padEnd(18, 'X');

const accountIds: string[] = [];
const opportunityIds: string[] = [];
const leadIds: string[] = [];
const eventIds: string[] = [];

afterAll(async () => {
  if (opportunityIds.length > 0) {
    await query(`DELETE FROM opportunities WHERE id = ANY($1::uuid[])`, [opportunityIds]);
  }
  if (leadIds.length > 0) {
    await query(`DELETE FROM leads WHERE id = ANY($1::uuid[])`, [leadIds]);
  }
  if (accountIds.length > 0) {
    await query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accountIds]);
  }
  for (const eventId of eventIds) {
    await query(`DELETE FROM cdc_events WHERE event_id = $1`, [eventId]);
  }
  try {
    await deleteSalesforceRecord('Account', sfid('001', 'summary'));
    await deleteSalesforceRecord('Contact', sfid('003', 'summary'));
    await linkOrphanRecords();
  } catch {
    // best effort
  }
  await closePool();
});

describe('reporting', () => {
  it('is empty-safe and never throws', async () => {
    const summary = await getSalesSummary();
    for (const value of [
      summary.accounts,
      summary.contacts,
      summary.opportunities,
      summary.leads,
      summary.pipelineValue,
      summary.wonValue,
      summary.openOpportunities,
      summary.newLeads,
      summary.salesforceRecords,
      summary.localRecords,
    ]) {
      expect(typeof value).toBe('number');
      expect(Number.isFinite(value)).toBe(true);
    }

    const stages = await getOpportunitiesByStage();
    expect(stages.map((row) => row.stage)).toEqual([
      'Prospecting',
      'Qualification',
      'Proposal',
      'Negotiation',
      'Closed Won',
      'Closed Lost',
    ]);

    const status = await getSyncStatus();
    expect(typeof status.running).toBe('boolean');
    expect(Array.isArray(status.checkpoints)).toBe(true);
    expect(typeof status.counts.cdcEvents).toBe('number');
    expect(status.lagSeconds === null || typeof status.lagSeconds === 'number').toBe(true);
  });

  it('aggregates a known fixture as deltas', async () => {
    const before = await getSalesSummary();

    // Local rows: one account, one opportunity (open), one lead.
    const account = await createAccount({ name: `${prefix}-account` });
    accountIds.push(account.id);

    const open = await createOpportunity({
      name: `${prefix}-open`,
      account_id: account.id,
      stage: 'Proposal',
      amount: 1000,
    });
    opportunityIds.push(open.id);

    const won = await createOpportunity({
      name: `${prefix}-won`,
      account_id: account.id,
      stage: 'Closed Won',
      amount: 2500,
    });
    opportunityIds.push(won.id);

    const lost = await createOpportunity({
      name: `${prefix}-lost`,
      account_id: account.id,
      stage: 'Closed Lost',
      amount: 4000,
    });
    opportunityIds.push(lost.id);

    const lead = await createLead({
      full_name: `${prefix} Lead`,
      email: `${prefix}@example.com`,
    });
    leadIds.push(lead.id);

    // Salesforce rows: one account + one contact through the ingest path.
    const sfAccount = await applySalesforceRecord('Account', 'CREATE', {
      Id: sfid('001', 'summary'),
      Name: `${prefix}-sf-account`,
      SystemModstamp: '2025-01-01T00:00:00Z',
    });
    expect(sfAccount.outcome).toBe('applied');
    const sfContact = await applySalesforceRecord('Contact', 'CREATE', {
      Id: sfid('003', 'summary'),
      FirstName: 'Sf',
      LastName: 'Contact',
      AccountId: sfid('001', 'summary'),
      SystemModstamp: '2025-01-01T00:00:00Z',
    });
    expect(sfContact.outcome).toBe('applied');

    const after = await getSalesSummary();
    expect(after.accounts - before.accounts).toBe(2);
    expect(after.contacts - before.contacts).toBe(1);
    expect(after.opportunities - before.opportunities).toBe(3);
    expect(after.leads - before.leads).toBe(1);
    // pipeline = open only; won/lost are excluded from the pipeline.
    expect(after.pipelineValue - before.pipelineValue).toBe(1000);
    expect(after.wonValue - before.wonValue).toBe(2500);
    expect(after.openOpportunities - before.openOpportunities).toBe(1);
    expect(after.newLeads - before.newLeads).toBe(1);
    expect(after.salesforceRecords - before.salesforceRecords).toBe(2);
    // account + 3 opportunities + lead
    expect(after.localRecords - before.localRecords).toBe(5);
  });

  it('breaks opportunities down by stage with totals', async () => {
    const before = await getOpportunitiesByStage();
    const byStage = new Map<OpportunityStage, { count: number; totalAmount: number }>(
      before.map((row) => [row.stage, { count: row.count, totalAmount: row.totalAmount }]),
    );

    const account = await createAccount({ name: `${prefix}-stages` });
    accountIds.push(account.id);
    for (const [name, stage, amount] of [
      ['a', 'Negotiation', 100.5],
      ['b', 'Negotiation', 200],
      ['c', 'Qualification', 50],
    ] as const) {
      const opportunity = await createOpportunity({
        name: `${prefix}-stage-${name}`,
        account_id: account.id,
        stage,
        amount,
      });
      opportunityIds.push(opportunity.id);
    }

    const after = await getOpportunitiesByStage();
    const negotiation = after.find((row) => row.stage === 'Negotiation')!;
    const qualification = after.find((row) => row.stage === 'Qualification')!;
    expect(negotiation.count - byStage.get('Negotiation')!.count).toBe(2);
    expect(negotiation.totalAmount - byStage.get('Negotiation')!.totalAmount).toBeCloseTo(300.5, 2);
    expect(qualification.count - byStage.get('Qualification')!.count).toBe(1);
    expect(after).toHaveLength(6);
  });

  it('summarises leads with status/source breakdown and a since filter', async () => {
    const before = await getLeadSummary();
    const lead = await createLead({
      full_name: `${prefix}-summary`,
      email: `${prefix}-summary@example.com`,
      source: 'landing_page',
      consent: true,
    });
    leadIds.push(lead.id);

    const after = await getLeadSummary();
    expect(after.total - before.total).toBe(1);
    const newStatus = after.byStatus.find((row) => row.status === 'new')!;
    const beforeNew = before.byStatus.find((row) => row.status === 'new')!;
    expect(newStatus.count - beforeNew.count).toBe(1);
    const landing = after.bySource.find((row) => row.source === 'landing_page')!;
    const beforeLanding = before.bySource.find((row) => row.source === 'landing_page')!;
    expect(landing.count - beforeLanding.count).toBe(1);
    expect(after.latest.map((row) => row.id)).toContain(lead.id);
    expect(after.newToday).toBeGreaterThanOrEqual(1);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    const empty = await getLeadSummary({ since: future });
    expect(empty.total).toBe(0);
    expect(empty.latest).toEqual([]);
    expect(empty.byStatus.every((row) => row.count === 0)).toBe(true);

    await expect(getLeadSummary({ since: 'nope' })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('reports sync status including lag from the newest applied event', async () => {
    const before = await getSyncStatus();
    const eventId = `${prefix}:1`;
    eventIds.push(eventId);
    expect(await recordCdcEvent({
      event_id: eventId,
      channel: prefix,
      object_name: 'Account',
      record_id: sfid('001', 'summary'),
      change_type: 'UPDATE',
      replay_id: '1',
      payload: { hello: 'world' },
      latency_ms: 12,
    })).toEqual({ duplicate: false });

    await markCdcEventProcessed(eventId, 'applied');

    const after = await getSyncStatus();
    expect(after.counts.cdcEvents - before.counts.cdcEvents).toBe(1);
    expect(after.lastCdcEventAt).not.toBeNull();
    expect(after.lagSeconds).not.toBeNull();
    expect(after.lagSeconds!).toBeGreaterThanOrEqual(0);
    expect(after.lagSeconds!).toBeLessThan(120);

    const events = await listCdcEvents({ status: 'applied', limit: 200 });
    expect(events.some((row) => row.event_id === eventId)).toBe(true);
  });
});
