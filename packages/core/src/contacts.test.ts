import { afterAll, describe, expect, it } from 'vitest';
import { createAccount } from './accounts';
import { createContact, getContact, listContacts, updateContact } from './contacts';
import { closePool, query } from './db';
import { AppError } from './errors';

const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prefix = `vitest-contacts-${run}`;
const createdContactIds: string[] = [];
const createdAccountIds: string[] = [];

afterAll(async () => {
  if (createdContactIds.length > 0) {
    await query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [createdContactIds]);
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

describe('contacts service', () => {
  it('creates a contact linked to an account and reads it back', async () => {
    const account = await makeAccount('acme');
    const contact = await createContact({
      first_name: 'Grace',
      last_name: 'Hopper',
      email: 'Grace.Hopper@Example.com',
      phone: '+1 555 0100',
      title: 'CTO',
      account_id: account.id,
    });
    createdContactIds.push(contact.id);

    expect(contact.account_id).toBe(account.id);
    expect(contact.account_name).toBe(account.name);
    expect(contact.source).toBe('local');
    expect(contact.salesforce_id).toBeNull();
    expect(contact.created_at).toBeTypeOf('string');

    const fetched = await getContact(contact.id);
    expect(fetched).toEqual(contact);
  });

  it('accepts a Salesforce account id when creating a contact', async () => {
    const account = await makeAccount('sf-linked');
    // Give the account a salesforce id directly; the contact service should
    // resolve it to the local uuid.
    const sfid = `003${run.replace(/[^a-zA-Z0-9]/g, '').slice(0, 15)}`;
    await query(`UPDATE accounts SET salesforce_id = $2, source = 'salesforce' WHERE id = $1`, [
      account.id,
      sfid,
    ]);

    const contact = await createContact({ last_name: 'Turing', account_id: sfid });
    createdContactIds.push(contact.id);
    expect(contact.account_id).toBe(account.id);
  });

  it('rejects contacts without any identifying field', async () => {
    await expect(createContact({})).rejects.toBeInstanceOf(AppError);
    await expect(createContact({ email: 'not-an-email' })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('rejects an unknown account reference', async () => {
    await expect(createContact({ last_name: 'X', account_id: 'bogus' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(
      createContact({ last_name: 'X', account_id: '001000000000000AAA' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('lists with search, account filter and pagination', async () => {
    const account = await makeAccount('list');
    const names = ['Alpha', 'Bravo', 'Charlie'];
    for (const name of names) {
      const contact = await createContact({
        first_name: name,
        last_name: `${prefix}-last`,
        account_id: account.id,
      });
      createdContactIds.push(contact.id);
    }

    const page = await listContacts({ account_id: account.id, limit: 2 });
    expect(page.total).toBe(3);
    expect(page.data).toHaveLength(2);
    expect(page.limit).toBe(2);

    const bySalesforceAccount = await listContacts({ account_id: account.id, search: 'Bravo' });
    expect(bySalesforceAccount.total).toBe(1);
    expect(bySalesforceAccount.data[0]!.first_name).toBe('Bravo');

    const search = await listContacts({ search: `${prefix}-last` });
    expect(search.total).toBe(3);

    await expect(listContacts({ account_id: 'nope' })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('updates fields, re-links and unlinks the account', async () => {
    const account = await makeAccount('update');
    const contact = await createContact({ last_name: 'Before', account_id: account.id });
    createdContactIds.push(contact.id);

    const updated = await updateContact(contact.id, {
      last_name: 'After',
      title: 'VP',
      email: 'vp@example.com',
    });
    expect(updated.last_name).toBe('After');
    expect(updated.title).toBe('VP');
    expect(updated.email).toBe('vp@example.com');
    expect(updated.account_id).toBe(account.id);

    const unlinked = await updateContact(contact.id, { account_id: null });
    expect(unlinked.account_id).toBeNull();
    expect(unlinked.account_name).toBeNull();

    await expect(updateContact('not-an-id', { last_name: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(getContact('not-an-id')).rejects.toMatchObject({ code: 'not_found' });
  });
});
