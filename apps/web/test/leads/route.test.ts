import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, createLead, query, queryOne } from '@poc/core';
import { POST } from '../../app/api/leads/route';
import { reset as resetRateLimit } from '../../lib/leads/rate-limit';

/**
 * Route-handler tests: the `POST` export is called directly with a `Request`,
 * so no Next server is needed. Rows are prefixed `vitest-lead-` and removed in
 * `afterAll`.
 */
const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prefix = `vitest-lead-${run}`;
const EMAIL_DOMAIN = 'example.com';

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function emailFor(label: string): string {
  return `${prefix}-${label}@${EMAIL_DOMAIN}`;
}

function postRequest(body: unknown, ip = nextIp()): Request {
  return new Request('http://localhost:3000/api/leads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

type Json = {
  data?: { id: string; status: string; source: string; created_at: string };
  duplicate?: boolean;
  error?: { code: string; message: string; details?: Record<string, string> };
};

async function submit(body: unknown, ip?: string): Promise<{ status: number; json: Json }> {
  const response = await POST(postRequest(body, ip));
  const json = (await response.json()) as Json;
  return { status: response.status, json };
}

async function countFor(email: string): Promise<number> {
  const row = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM leads WHERE lower(email) = lower($1)`,
    [email],
  );
  return row?.total ?? 0;
}

beforeEach(() => {
  resetRateLimit();
});

afterAll(async () => {
  await query(`DELETE FROM leads WHERE email LIKE $1`, ['vitest-lead-%']);
  await closePool();
});

describe('POST /api/leads', () => {
  it('creates a landing-page lead with status new and consent_at set', async () => {
    const email = emailFor('valid');
    const { status, json } = await submit({
      full_name: '  Maria Silva  ',
      email: email.toUpperCase(),
      phone: '+55 11 99999-0000',
      property_interest: 'House',
      message: 'Looking for a 3-bed near the park',
      consent: true,
    });

    expect(status).toBe(201);
    expect(json.duplicate).toBeUndefined();
    expect(json.data?.source).toBe('landing_page');
    expect(json.data?.status).toBe('new');
    expect(json.data?.id).toBeTypeOf('string');
    expect(json.data?.created_at).toBeTypeOf('string');
    // Never leak more than the four public fields.
    expect(Object.keys(json.data ?? {}).sort()).toEqual(['created_at', 'id', 'source', 'status']);

    const row = await queryOne<{
      full_name: string;
      email: string;
      status: string;
      source: string;
      consent: boolean;
      consent_at: string | null;
      phone: string | null;
      message: string | null;
    }>(
      `SELECT full_name, email, status, source, consent, consent_at, phone, message
         FROM leads WHERE id = $1`,
      [json.data?.id],
    );
    expect(row).not.toBeNull();
    expect(row?.full_name).toBe('Maria Silva');
    expect(row?.email).toBe(email.toLowerCase());
    expect(row?.status).toBe('new');
    expect(row?.source).toBe('landing_page');
    expect(row?.consent).toBe(true);
    expect(row?.consent_at).not.toBeNull();
    expect(row?.phone).toBe('+55 11 99999-0000');
    expect(row?.message).toBe('Looking for a 3-bed near the park');
  });

  it('treats a repeat submission within 24h as a duplicate and inserts nothing', async () => {
    const email = emailFor('duplicate');
    const payload = { full_name: 'Duplicate Person', email, consent: true };

    const first = await submit(payload);
    expect(first.status).toBe(201);

    const second = await submit(payload);
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBe(true);
    expect(second.json.data?.id).toBe(first.json.data?.id);
    expect(await countFor(email)).toBe(1);
  });

  it('does not treat a lead from another source as a duplicate', async () => {
    const email = emailFor('other-source');
    const manual = await createLead({
      full_name: 'Manual Import',
      email,
      source: 'manual',
      status: 'contacted',
    });

    const { status, json } = await submit({ full_name: 'Landing Person', email, consent: true });
    expect(status).toBe(201);
    expect(json.duplicate).toBeUndefined();
    expect(json.data?.id).not.toBe(manual.id);
    expect(json.data?.source).toBe('landing_page');
    expect(await countFor(email)).toBe(2);
  });

  it('rejects a name shorter than 2 characters with a field error', async () => {
    const email = emailFor('short-name');
    const { status, json } = await submit({ full_name: 'X', email, consent: true });

    expect(status).toBe(400);
    expect(json.error?.code).toBe('validation_error');
    expect(json.error?.details?.full_name).toBeTypeOf('string');
    expect(await countFor(email)).toBe(0);
  });

  it('rejects an invalid email with a field error', async () => {
    const { status, json } = await submit({ full_name: 'Valid Name', email: 'bad', consent: true });

    expect(status).toBe(400);
    expect(json.error?.code).toBe('validation_error');
    expect(json.error?.details?.email).toBeTypeOf('string');
  });

  it('rejects a missing consent with a field error', async () => {
    const email = emailFor('no-consent');
    const { status, json } = await submit({ full_name: 'Valid Name', email });

    expect(status).toBe(400);
    expect(json.error?.details?.consent).toBeTypeOf('string');
    expect(await countFor(email)).toBe(0);
  });

  it('rejects an oversized message with a field error', async () => {
    const email = emailFor('long-message');
    const { status, json } = await submit({
      full_name: 'Valid Name',
      email,
      message: 'x'.repeat(2001),
      consent: true,
    });

    expect(status).toBe(400);
    expect(json.error?.details?.message).toBeTypeOf('string');
    expect(await countFor(email)).toBe(0);
  });

  it('returns every invalid field at once (the demo bad-payload case)', async () => {
    const { status, json } = await submit({ full_name: 'X', email: 'bad', consent: false });

    expect(status).toBe(400);
    expect(Object.keys(json.error?.details ?? {}).sort()).toEqual(['consent', 'email', 'full_name']);
  });

  it('stores nothing when the honeypot is filled but still looks successful', async () => {
    const email = emailFor('honeypot');
    const { status, json } = await submit({
      full_name: 'Spam Bot',
      email,
      consent: true,
      company_website: 'https://spam.example',
    });

    expect(status).toBe(201);
    expect(json.data?.status).toBe('new');
    expect(await countFor(email)).toBe(0);
  });

  it('rejects a malformed JSON body with 400', async () => {
    const { status, json } = await submit('{"full_name": "Broken"');

    expect(status).toBe(400);
    expect(json.error?.code).toBe('validation_error');
  });

  it('blocks the sixth submission from the same IP with 429', async () => {
    const ip = '203.0.113.42';
    for (let i = 0; i < 5; i += 1) {
      const { status } = await submit(
        { full_name: `Rate Person ${i}`, email: emailFor(`rate-${i}`), consent: true },
        ip,
      );
      expect(status).toBe(201);
    }

    const blocked = await POST(postRequest({ full_name: 'Rate Person 6', email: emailFor('rate-6'), consent: true }, ip));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    const body = (await blocked.json()) as Json;
    expect(body.error?.code).toBe('rate_limited');
    expect(await countFor(emailFor('rate-6'))).toBe(0);
  });
});
