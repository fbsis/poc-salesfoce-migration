/**
 * Route-level coverage for the two limits that can only be seen end to end
 * through `POST /api/leads` (AUDIT P0-3):
 *
 *  - **unknown IP** (no proxy headers, i.e. exactly what the shipped compose
 *    file does): a burst of submissions must NOT be rejected at #6 — the old
 *    limiter put every visitor in one shared 5-per-10-min bucket;
 *  - **per email**: a 3rd landing-page submission for one address inside the
 *    10-minute window is a 429 with its own message;
 *  - **concurrent duplicates**: the TOC-TOU fix seen through the handler.
 *
 * Rows are prefixed `vitest-limits-` and removed in `afterAll`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query, queryOne } from '@poc/core';
import { POST } from '../../app/api/leads/route';
import { GLOBAL_MAX_SUBMISSIONS, reset as resetRateLimit } from '../../lib/leads/rate-limit';

const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prefix = `vitest-limits-${run}`;

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function emailFor(label: string): string {
  return `${prefix}-${label}@example.com`;
}

/** No proxy headers at all — the compose deployment, i.e. `unknown` IP. */
function directRequest(body: unknown): Request {
  return new Request('http://localhost:3000/api/leads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function proxiedRequest(body: unknown, ip: string): Request {
  return new Request('http://localhost:3000/api/leads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

type Json = {
  data?: { id: string; status: string; source: string; created_at: string };
  duplicate?: boolean;
  error?: { code: string; message: string };
};

async function submit(request: Request): Promise<{ status: number; json: Json; retryAfter: string | null }> {
  const response = await POST(request);
  return {
    status: response.status,
    json: (await response.json()) as Json,
    retryAfter: response.headers.get('retry-after'),
  };
}

async function rowsFor(email: string): Promise<number> {
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
  await query(`DELETE FROM leads WHERE email LIKE $1`, ['vitest-limits-%']);
  await closePool();
});

describe('POST /api/leads — unknown-IP burst (P0-3)', () => {
  it('accepts seven submissions from one un-proxied client without a 429', async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 7; i += 1) {
      const { status } = await submit(
        directRequest({ full_name: `Direct ${i}`, email: emailFor(`direct-${i}`), consent: true }),
      );
      statuses.push(status);
    }

    expect(statuses).toEqual([201, 201, 201, 201, 201, 201, 201]);
    expect(await rowsFor(emailFor('direct-6'))).toBe(1);
    expect(await rowsFor(emailFor('direct-7'))).toBe(1);
  });

  it('still caps unknown-IP traffic at the generous global limit', async () => {
    // Burn the bucket directly: submitting 60+ real rows would be wasteful.
    const { check, UNKNOWN_IP } = await import('../../lib/leads/rate-limit');
    for (let i = 0; i < GLOBAL_MAX_SUBMISSIONS; i += 1) expect(check(UNKNOWN_IP).allowed).toBe(true);

    const blocked = await submit(
      directRequest({ full_name: 'Too Much', email: emailFor('global-cap'), consent: true }),
    );
    expect(blocked.status).toBe(429);
    expect(blocked.json.error?.code).toBe('rate_limited');
    expect(blocked.json.error?.message).toContain('60 per 10 minutes');
    expect(blocked.retryAfter).toBeTruthy();
    expect(await rowsFor(emailFor('global-cap'))).toBe(0);
  });
});

describe('POST /api/leads — per-IP limit is preserved when the header is present', () => {
  it('blocks the sixth submission from one real IP with the per-IP message', async () => {
    const ip = '203.0.113.77';
    for (let i = 1; i <= 5; i += 1) {
      const { status } = await submit(
        proxiedRequest({ full_name: `IP Person ${i}`, email: emailFor(`ip-${i}`), consent: true }, ip),
      );
      expect(status).toBe(201);
    }

    const blocked = await submit(
      proxiedRequest({ full_name: 'IP Person 6', email: emailFor('ip-6'), consent: true }, ip),
    );
    expect(blocked.status).toBe(429);
    expect(blocked.json.error?.code).toBe('rate_limited');
    expect(blocked.json.error?.message).toContain('5 per 10 minutes');
    expect(blocked.retryAfter).toBeTruthy();
    expect(await rowsFor(emailFor('ip-6'))).toBe(0);
  });

  it('does not let one IP exhaust another IP', async () => {
    for (let i = 0; i < 5; i += 1) {
      await submit(proxiedRequest({ full_name: `Busy ${i}`, email: emailFor(`busy-${i}`), consent: true }, '203.0.113.78'));
    }
    const other = await submit(
      proxiedRequest({ full_name: 'Other IP', email: emailFor('other-ip'), consent: true }, '203.0.113.79'),
    );
    expect(other.status).toBe(201);
  });
});

describe('POST /api/leads — per-email guard', () => {
  it('rejects a third submission for one address with 429 and its own message', async () => {
    const email = emailFor('same-address');

    const first = await submit(directRequest({ full_name: 'Same Person', email, consent: true }));
    expect(first.status).toBe(201);

    const second = await submit(directRequest({ full_name: 'Same Person', email, consent: true }));
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBe(true);
    expect(second.json.data?.id).toBe(first.json.data?.id);

    const third = await submit(directRequest({ full_name: 'Same Person', email, consent: true }));
    expect(third.status).toBe(429);
    expect(third.json.error?.code).toBe('rate_limited');
    expect(third.json.error?.message).toContain('email address');
    expect(third.json.error?.message).not.toContain('from this address');
    expect(third.retryAfter).toBeTruthy();
    expect(await rowsFor(email)).toBe(1);
  });

  it('is scoped per address and independent of the IP bucket', async () => {
    const ip = '203.0.113.80';
    for (let i = 0; i < 2; i += 1) {
      const { status } = await submit(
        proxiedRequest({ full_name: `Scoped ${i}`, email: emailFor('scoped'), consent: true }, ip),
      );
      expect(status).toBe(i === 0 ? 201 : 200);
    }

    const third = await submit(
      proxiedRequest({ full_name: 'Scoped 3', email: emailFor('scoped'), consent: true }, ip),
    );
    expect(third.status).toBe(429);

    // A different address from the same IP still has per-IP headroom.
    const other = await submit(
      proxiedRequest({ full_name: 'Different', email: emailFor('different'), consent: true }, ip),
    );
    expect(other.status).toBe(201);
  });
});

describe('POST /api/leads — concurrent duplicates (P1-5)', () => {
  it('inserts exactly one row for two concurrent identical submissions', async () => {
    const email = emailFor('concurrent');
    const body = { full_name: 'Race Person', email, consent: true };

    const results = await Promise.all(
      Array.from({ length: 2 }, () => submit(proxiedRequest(body, nextIp()))),
    );

    expect(results.map((result) => result.status).sort()).toEqual([200, 201]);
    const ids = new Set(results.map((result) => result.json.data?.id));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.json.duplicate === true)).toHaveLength(1);
    expect(await rowsFor(email)).toBe(1);
  });
});
