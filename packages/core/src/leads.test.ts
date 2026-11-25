import { afterAll, describe, expect, it } from 'vitest';
import { closePool, query } from './db';
import {
  createLead,
  getLead,
  getLeadByEmail,
  listLeads,
  searchLeads,
  updateLead,
  updateLeadStatus,
} from './leads';

const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prefix = `vitest-leads-${run}`;
const createdLeadIds: string[] = [];

afterAll(async () => {
  if (createdLeadIds.length > 0) {
    await query(`DELETE FROM leads WHERE id = ANY($1::uuid[])`, [createdLeadIds]);
  }
  await closePool();
});

describe('leads service', () => {
  it('creates a landing-page lead with lower-cased email and consent timestamp', async () => {
    const lead = await createLead({
      full_name: '  Ada Lovelace  ',
      email: 'Ada.Lovelace@Example.COM',
      phone: '555-0100',
      property_interest: 'Condo',
      message: 'Interested in a viewing',
      consent: true,
    });
    createdLeadIds.push(lead.id);

    expect(lead.email).toBe('ada.lovelace@example.com');
    expect(lead.full_name).toBe('Ada Lovelace');
    expect(lead.source).toBe('landing_page');
    expect(lead.status).toBe('new');
    expect(lead.consent).toBe(true);
    expect(lead.consent_at).not.toBeNull();
    expect(lead.salesforce_id).toBeNull();
    expect(lead.created_at).toBeTypeOf('string');
  });

  it('omits consent_at when consent is not given', async () => {
    const lead = await createLead({
      full_name: 'No Consent',
      email: `no-consent-${run}@example.com`,
      source: 'manual',
      status: 'contacted',
    });
    createdLeadIds.push(lead.id);

    expect(lead.consent).toBe(false);
    expect(lead.consent_at).toBeNull();
    expect(lead.source).toBe('manual');
    expect(lead.status).toBe('contacted');
  });

  it('validates required fields through zod', async () => {
    await expect(createLead({ full_name: 'A', email: 'a@example.com' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(createLead({ full_name: 'Valid', email: 'nope' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(createLead({} as never)).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      createLead({ full_name: 'Valid', email: 'v@example.com', status: 'bogus' as never }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('looks leads up by uuid, email and search term', async () => {
    const lead = await createLead({
      full_name: `Searchable ${run}`,
      email: `Searchable-${run}@Example.com`,
      company: 'Globex',
    });
    createdLeadIds.push(lead.id);

    const fetched = await getLead(lead.id);
    expect(fetched.id).toBe(lead.id);

    const byEmail = await getLeadByEmail(`  SEARCHABLE-${run}@example.COM  `);
    expect(byEmail?.id).toBe(lead.id);
    expect(await getLeadByEmail('nobody@example.invalid')).toBeNull();

    const searched = await searchLeads(`Searchable ${run}`);
    expect(searched.map((row) => row.id)).toContain(lead.id);

    const byCompany = await searchLeads('Globex');
    expect(byCompany.map((row) => row.id)).toContain(lead.id);

    expect(await searchLeads('   ')).toEqual([]);
    await expect(getLead('not-an-id')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists with status/source/search/since filters and pagination', async () => {
    for (const [name, status, source] of [
      ['a', 'new', 'landing_page'],
      ['b', 'qualified', 'salesforce'],
      ['c', 'qualified', 'landing_page'],
    ] as const) {
      const lead = await createLead({
        full_name: `${prefix}-${name}`,
        email: `${prefix}-${name}@example.com`,
        status,
        source,
      });
      createdLeadIds.push(lead.id);
    }

    const all = await listLeads({ search: prefix });
    expect(all.total).toBe(3);
    expect(all.data[0]!.created_at >= all.data[2]!.created_at).toBe(true);

    const qualified = await listLeads({ search: prefix, status: 'qualified' });
    expect(qualified.total).toBe(2);

    const landing = await listLeads({ search: prefix, source: 'landing_page' });
    expect(landing.total).toBe(2);

    const page = await listLeads({ search: prefix, limit: 2, offset: 2 });
    expect(page.total).toBe(3);
    expect(page.data).toHaveLength(1);
    expect(page.limit).toBe(2);

    const sinceFuture = await listLeads({
      search: prefix,
      created_since: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(sinceFuture.total).toBe(0);

    await expect(listLeads({ created_since: 'not-a-date' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(listLeads({ status: 'bogus' as never })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('updates status and other fields', async () => {
    const lead = await createLead({
      full_name: `${prefix}-update`,
      email: `${prefix}-update@example.com`,
    });
    createdLeadIds.push(lead.id);

    const contacted = await updateLeadStatus(lead.id, 'contacted');
    expect(contacted.status).toBe('contacted');

    const updated = await updateLead(lead.id, {
      full_name: 'Updated Name',
      email: `Updated-${run}@Example.com`,
      company: 'Initech',
      phone: null,
    });
    expect(updated.full_name).toBe('Updated Name');
    expect(updated.email).toBe(`updated-${run}@example.com`);
    expect(updated.company).toBe('Initech');
    expect(updated.phone).toBeNull();
    expect(updated.status).toBe('contacted');

    await expect(updateLeadStatus(lead.id, 'bogus' as never)).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(
      updateLeadStatus('00000000-0000-4000-8000-000000000000', 'closed'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
