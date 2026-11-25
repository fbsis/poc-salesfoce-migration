/**
 * GET  /api/crm/contacts — list (`search, account_id, limit, offset`)
 * POST /api/crm/contacts — create ({ first_name?, last_name?, email?, phone?, title?, account_id? })
 * docs/CONTRACTS.md §4.
 */
import { createContact, createContactSchema, listContacts, validate } from '@poc/core';
import { requireCrmToken } from '../../../../lib/api/auth';
import { created, list, readJsonBody, withRoute } from '../../../../lib/api/respond';
import { listContactsParamsSchema, parseQuery } from '../../../../lib/api/schemas';

export const dynamic = 'force-dynamic';

export const GET = withRoute(async (request: Request) => {
  requireCrmToken(request);
  const params = parseQuery(listContactsParamsSchema, request);
  return list(await listContacts(params));
});

export const POST = withRoute(async (request: Request) => {
  requireCrmToken(request);
  const input = validate(createContactSchema, await readJsonBody(request));
  return created(await createContact(input));
});
