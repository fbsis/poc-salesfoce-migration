/**
 * GET  /api/crm/accounts  — list (`search, source, limit, offset`)
 * POST /api/crm/accounts  — create ({ name, industry?, website?, billing_country?, owner_name? })
 * docs/CONTRACTS.md §4. Auth -> parse -> @poc/core -> envelope.
 */
import { createAccount, createAccountSchema, listAccounts } from '@poc/core';
import { requireCrmToken } from '../../../../lib/api/auth';
import { created, list, readJsonBody, withRoute } from '../../../../lib/api/respond';
import { listAccountsParamsSchema, parseQuery } from '../../../../lib/api/schemas';
import { validate } from '@poc/core';

export const dynamic = 'force-dynamic';

export const GET = withRoute(async (request: Request) => {
  requireCrmToken(request);
  const params = parseQuery(listAccountsParamsSchema, request);
  return list(await listAccounts(params));
});

export const POST = withRoute(async (request: Request) => {
  requireCrmToken(request);
  const input = validate(createAccountSchema, await readJsonBody(request));
  return created(await createAccount(input));
});
