/**
 * `POST /api/leads` — the only public, unauthenticated write endpoint
 * (docs/CONTRACTS.md §5).
 *
 * Flow: rate limit → parse JSON → honeypot → validate → duplicate check →
 * `createLead` from `@poc/core`. All DB access goes through the core service;
 * no SQL here.
 *
 * Never logs or returns the raw email or the message: only a truncated SHA-256
 * of the email for correlation.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createLead, getLeadByEmail, listLeads, type Lead } from '@poc/core';
import { check as checkRateLimit, clientIpFromHeaders } from '../../../lib/leads/rate-limit';
import { honeypotTripped, parseLeadSubmission } from '../../../lib/leads/schema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE = 'landing_page' as const;

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function errorJson(
  code: string,
  message: string,
  status: number,
  extra?: { details?: unknown; headers?: Record<string, string> },
): Response {
  return json(
    { error: { code, message, ...(extra?.details === undefined ? {} : { details: extra.details }) } },
    status,
    extra?.headers,
  );
}

/** Only shape of a lead the public endpoint is ever allowed to see. */
function publicLead(lead: Lead) {
  return {
    id: lead.id,
    status: lead.status,
    source: lead.source,
    created_at: lead.created_at,
  };
}

function isRecentLandingPageLead(lead: Lead | null, email: string): lead is Lead {
  if (!lead) return false;
  if (lead.source !== SOURCE) return false;
  if (lead.email.trim().toLowerCase() !== email) return false;
  const createdAt = Date.parse(lead.created_at);
  if (Number.isNaN(createdAt)) return false;
  return Date.now() - createdAt < DAY_MS;
}

/**
 * Same email + `source='landing_page'` + `created_at` within 24 h.
 * `getLeadByEmail` covers the common case; the fallback search covers the case
 * where a newer lead from another source shadows an older landing-page row
 * (a lead from another source is explicitly NOT a duplicate).
 */
async function findDuplicate(email: string): Promise<Lead | null> {
  const direct = await getLeadByEmail(email);
  if (isRecentLandingPageLead(direct, email)) return direct;

  const since = new Date(Date.now() - DAY_MS).toISOString();
  const candidates = await listLeads({ search: email, source: SOURCE, created_since: since, limit: 10 });
  return candidates.data.find((lead) => isRecentLandingPageLead(lead, email)) ?? null;
}

/** Truncated hash — enough to correlate repeated submissions, useless alone. */
function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12);
}

type Outcome = 'created' | 'duplicate' | 'invalid' | 'rate_limited' | 'honeypot' | 'malformed' | 'error';

function logSubmission(fields: {
  outcome: Outcome;
  ip: string;
  email?: string;
  leadId?: string | null;
  status: number;
  fields?: string[];
}): void {
  const parts = [
    `[leads] submission outcome=${fields.outcome}`,
    `status=${fields.status}`,
    `ip=${fields.ip}`,
    fields.email ? `email_sha256=${hashEmail(fields.email)}` : 'email_sha256=-',
    `lead_id=${fields.leadId ?? '-'}`,
    fields.fields && fields.fields.length > 0 ? `invalid_fields=${fields.fields.join(',')}` : '',
  ].filter(Boolean);
  console.info(parts.join(' '));
}

export async function POST(request: Request): Promise<Response> {
  const ip = clientIpFromHeaders(request.headers);

  // 1. Rate limit (counts every attempt, including invalid ones).
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    logSubmission({ outcome: 'rate_limited', ip, status: 429 });
    return errorJson('rate_limited', 'Too many submissions from this address. Please try again later.', 429, {
      headers: { 'retry-after': String(limit.retryAfterSeconds) },
    });
  }

  // 2. Parse JSON.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logSubmission({ outcome: 'malformed', ip, status: 400 });
    return errorJson('validation_error', 'Request body must be valid JSON', 400, {
      details: { _: 'Malformed JSON body' },
    });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    logSubmission({ outcome: 'invalid', ip, status: 400 });
    return errorJson('validation_error', 'Request body must be a JSON object', 400, {
      details: { _: 'Expected a JSON object' },
    });
  }
  const payload = body as Record<string, unknown>;

  // 3. Honeypot: look successful, store nothing.
  if (honeypotTripped(payload)) {
    logSubmission({ outcome: 'honeypot', ip, status: 201 });
    return json(
      {
        data: {
          id: randomUUID(),
          status: 'new',
          source: SOURCE,
          created_at: new Date().toISOString(),
        },
      },
      201,
    );
  }

  // 4. Validate.
  const parsed = parseLeadSubmission(payload);
  if (!parsed.ok) {
    logSubmission({
      outcome: 'invalid',
      ip,
      status: 400,
      fields: Object.keys(parsed.fieldErrors),
    });
    return errorJson('validation_error', 'Please correct the highlighted fields', 400, {
      details: parsed.fieldErrors,
    });
  }
  const data = parsed.data;

  try {
    // 5. Duplicate check — 24 h window, landing-page rows only.
    const duplicate = await findDuplicate(data.email);
    if (duplicate) {
      logSubmission({
        outcome: 'duplicate',
        ip,
        email: data.email,
        leadId: duplicate.id,
        status: 200,
      });
      return json({ data: publicLead(duplicate), duplicate: true }, 200);
    }

    // 6. Create through the core service (source/status/consent_at enforced there).
    const lead = await createLead({
      full_name: data.full_name,
      email: data.email,
      phone: data.phone,
      property_interest: data.property_interest,
      message: data.message,
      source: SOURCE,
      status: 'new',
      consent: true,
    });

    logSubmission({ outcome: 'created', ip, email: data.email, leadId: lead.id, status: 201 });
    return json({ data: publicLead(lead) }, 201);
  } catch (error) {
    console.error(
      '[leads] submission failed',
      error instanceof Error ? `email_sha256=${hashEmail(data.email)} ${error.message}` : 'unknown error',
    );
    return errorJson('internal', 'Could not save your details. Please try again.', 500);
  }
}
