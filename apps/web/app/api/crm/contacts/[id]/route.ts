/**
 * GET   /api/crm/contacts/[id] — uuid or Salesforce id
 * PATCH /api/crm/contacts/[id] — partial update
 * docs/CONTRACTS.md §4.
 */
import { getContact, idSchema, updateContact, updateContactSchema, validate } from '@poc/core';
import { requireCrmToken } from '../../../../../lib/api/auth';
import { ok, readJsonBody, withRoute } from '../../../../../lib/api/respond';
import { requireNonEmptyPatch } from '../../../../../lib/api/schemas';

export const dynamic = 'force-dynamic';

type IdContext = { params: Promise<{ id: string }> };

export const GET = withRoute<IdContext>(async (request, context) => {
  requireCrmToken(request);
  const { id } = await context.params;
  return ok(await getContact(validate(idSchema, id)));
});

export const PATCH = withRoute<IdContext>(async (request, context) => {
  requireCrmToken(request);
  const { id } = await context.params;
  const body = await readJsonBody(request);
  requireNonEmptyPatch(body);
  const input = validate(updateContactSchema, body);
  return ok(await updateContact(validate(idSchema, id), input));
});
