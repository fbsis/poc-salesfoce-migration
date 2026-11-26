/**
 * `POST /api/leads` — the only public, unauthenticated write endpoint
 * (docs/CONTRACTS.md §5).
 *
 * Flow: rate limit → parse JSON → honeypot → validate → per-email guard →
 * atomic find-or-create (`lib/leads/dedupe.ts`).
 *
 * Rate limits (see `lib/leads/rate-limit.ts` for the full rationale):
 *  - 5 submissions / 10 min per IP, when the proxy headers carry a real IP;
 *  - 60 submissions / 10 min per process for unknown-IP traffic (no proxy);
 *  - 2 submissions / 10 min per email address — the 3rd is rejected.
 *
 * Never logs or returns the raw email or the message: only a truncated SHA-256
 * of the email for correlation.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Lead } from '@poc/core';
import { findOrCreateLandingLead } from '../../../lib/leads/dedupe';
import {
  check as checkRateLimit,
  checkEmail as checkEmailRateLimit,
  clientIpFromHeaders,
} from '../../../lib/leads/rate-limit';
import { honeypotTripped, parseLeadSubmission } from '../../../lib/leads/schema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

/** Truncated hash — enough to correlate repeated submissions, useless alone. */
function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12);
}

type Outcome = 'created' | 'duplicate' | 'invalid' | 'rate_limited' | 'honeypot' | 'malformed' | 'error';

function logSubmission(fields: {
  outcome: Outcome;
  ip: string;
  /** Which limiter decided this request: `ip` (proxy header present) or `global` (no proxy). */
  bucket: 'ip' | 'global' | 'email';
  email?: string;
  leadId?: string | null;
  status: number;
  fields?: string[];
}): void {
  const parts = [
    `[leads] submission outcome=${fields.outcome}`,
    `status=${fields.status}`,
    `bucket=${fields.bucket}`,
    `ip=${fields.ip}`,
    fields.email ? `email_sha256=${hashEmail(fields.email)}` : 'email_sha256=-',
    `lead_id=${fields.leadId ?? '-'}`,
    fields.fields && fields.fields.length > 0 ? `invalid_fields=${fields.fields.join(',')}` : '',
  ].filter(Boolean);
  console.info(parts.join(' '));
}

export async function POST(request: Request): Promise<Response> {
  const ip = clientIpFromHeaders(request.headers);

  // 1. Rate limit (counts every attempt, including invalid ones). `bucket` is
  // logged on every outcome: `global` means no proxy header reached us, so the
  // per-IP limit is not in force and the deployment should get a proxy.
  const limit = checkRateLimit(ip);
  const bucket = limit.bucket;
  if (!limit.allowed) {
    logSubmission({ outcome: 'rate_limited', ip, bucket, status: 429 });
    const message =
      bucket === 'global'
        ? 'Too many submissions for this server right now (60 per 10 minutes). Please try again later.'
        : 'Too many submissions from this address (5 per 10 minutes). Please try again later.';
    return errorJson('rate_limited', message, 429, {
      headers: { 'retry-after': String(limit.retryAfterSeconds) },
    });
  }

  // 2. Parse JSON.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logSubmission({ outcome: 'malformed', ip, bucket, status: 400 });
    return errorJson('validation_error', 'Request body must be valid JSON', 400, {
      details: { _: 'Malformed JSON body' },
    });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    logSubmission({ outcome: 'invalid', ip, bucket, status: 400 });
    return errorJson('validation_error', 'Request body must be a JSON object', 400, {
      details: { _: 'Expected a JSON object' },
    });
  }
  const payload = body as Record<string, unknown>;

  // 3. Honeypot: look successful, store nothing.
  if (honeypotTripped(payload)) {
    logSubmission({ outcome: 'honeypot', ip, bucket, status: 201 });
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
      bucket,
      status: 400,
      fields: Object.keys(parsed.fieldErrors),
    });
    return errorJson('validation_error', 'Please correct the highlighted fields', 400, {
      details: parsed.fieldErrors,
    });
  }
  const data = parsed.data;

  // 5. Per-email guard: the 3rd submission for the same address inside the
  // 10-minute window is rejected even when every visitor looks like `unknown`.
  const emailLimit = checkEmailRateLimit(data.email);
  if (!emailLimit.allowed) {
    logSubmission({
      outcome: 'rate_limited',
      ip,
      bucket: 'email',
      email: data.email,
      status: 429,
    });
    return errorJson(
      'rate_limited',
      'Too many submissions for this email address (2 per 10 minutes). Please try again later.',
      429,
      { headers: { 'retry-after': String(emailLimit.retryAfterSeconds) } },
    );
  }

  try {
    // 6. Atomic duplicate check + insert (advisory lock, see lib/leads/dedupe.ts).
    const { lead, duplicate } = await findOrCreateLandingLead({
      full_name: data.full_name,
      email: data.email,
      phone: data.phone,
      property_interest: data.property_interest,
      message: data.message,
      source: SOURCE,
      status: 'new',
      consent: true,
    });

    if (duplicate) {
      logSubmission({
        outcome: 'duplicate',
        ip,
        bucket,
        email: data.email,
        leadId: lead.id,
        status: 200,
      });
      return json({ data: publicLead(lead), duplicate: true }, 200);
    }

    logSubmission({ outcome: 'created', ip, bucket, email: data.email, leadId: lead.id, status: 201 });
    return json({ data: publicLead(lead) }, 201);
  } catch (error) {
    console.error(
      '[leads] submission failed',
      error instanceof Error ? `email_sha256=${hashEmail(data.email)} ${error.message}` : 'unknown error',
    );
    return errorJson('internal', 'Could not save your details. Please try again.', 500);
  }
}
