/**
 * P1-5 — the landing-page "find or create" must be atomic.
 *
 * The old route did `findDuplicate()` then `createLead()`, so N concurrent
 * submissions of the same email all inserted. These tests drive the same email
 * through `findOrCreateLandingLead` with `Promise.all` and assert on the rows
 * in Postgres, not just on the returned objects.
 *
 * Rows are prefixed `vitest-dedupe-` and removed in `afterAll`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, query, queryOne } from '@poc/core';
import { DUPLICATE_WINDOW_HOURS, findOrCreateLandingLead } from '../../lib/leads/dedupe';

const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prefix = `vitest-dedupe-${run}`;

function emailFor(label: string): string {
  return `${prefix}-${label}@example.com`;
}

function payload(email: string, label: string) {
  return {
    full_name: `Concurrent ${label}`,
    email,
    property_interest: 'House',
    message: 'Race the dedupe',
    source: 'landing_page' as const,
    status: 'new' as const,
    consent: true,
  };
}

async function rowsFor(email: string): Promise<number> {
  const row = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM leads WHERE lower(email) = lower($1)`,
    [email],
  );
  return row?.total ?? 0;
}

afterAll(async () => {
  await query(`DELETE FROM leads WHERE email LIKE $1`, ['vitest-dedupe-%']);
  await closePool();
});

describe('findOrCreateLandingLead', () => {
  it('creates a single row for five identical concurrent submissions', async () => {
    const email = emailFor('race');

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) => findOrCreateLandingLead(payload(email, String(index)))),
    );

    expect(results).toHaveLength(5);
    expect(await rowsFor(email)).toBe(1);

    // Exactly one caller inserted; the rest observed the winner's row.
    expect(results.filter((result) => result.duplicate === false)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate === true)).toHaveLength(4);

    // One unique id, agreed on by every caller.
    const ids = new Set(results.map((result) => result.lead.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTypeOf('string');

    const created = results.find((result) => result.duplicate === false)?.lead;
    expect(created?.source).toBe('landing_page');
    expect(created?.status).toBe('new');
    expect(created?.consent).toBe(true);
    expect(created?.consent_at).not.toBeNull();
    // The winner's values are the ones stored.
    expect(created?.full_name).toMatch(/^Concurrent \d$/);

    const stored = await queryOne<{ email: string; source: string }>(
      `SELECT email, source FROM leads WHERE id = $1`,
      [created?.id],
    );
    expect(stored?.email).toBe(email);
    expect(stored?.source).toBe('landing_page');
  });

  it('returns the existing row with duplicate: true for a later submission', async () => {
    const email = emailFor('repeat');

    const first = await findOrCreateLandingLead(payload(email, 'first'));
    expect(first.duplicate).toBe(false);

    const second = await findOrCreateLandingLead(payload(email, 'second'));
    expect(second.duplicate).toBe(true);
    expect(second.lead.id).toBe(first.lead.id);
    // The duplicate path returns the stored row, not the new payload.
    expect(second.lead.full_name).toBe('Concurrent first');
    expect(await rowsFor(email)).toBe(1);
  });

  it('is case-insensitive on the email (one row for mixed case)', async () => {
    const base = emailFor('case');
    const upper = base.toUpperCase();

    const first = await findOrCreateLandingLead({ ...payload(base, 'lower'), email: base });
    const second = await findOrCreateLandingLead({ ...payload(upper, 'upper'), email: upper });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.lead.id).toBe(first.lead.id);
    expect(await rowsFor(base)).toBe(1);
  });

  it('does not treat a lead from another source as a duplicate', async () => {
    const email = emailFor('other-source');
    await query(
      `INSERT INTO leads (full_name, email, status, source) VALUES ($1, $2, 'contacted', 'manual')`,
      ['Manual Import', email],
    );

    const result = await findOrCreateLandingLead(payload(email, 'landing'));
    expect(result.duplicate).toBe(false);
    expect(result.lead.source).toBe('landing_page');
    expect(await rowsFor(email)).toBe(2);
  });

  it('ignores a landing-page row older than the duplicate window', async () => {
    const email = emailFor('stale');
    const created = await findOrCreateLandingLead(payload(email, 'stale'));
    expect(created.duplicate).toBe(false);

    await query(
      `UPDATE leads SET created_at = now() - ($2::int * interval '1 hour') WHERE id = $1`,
      [created.lead.id, DUPLICATE_WINDOW_HOURS + 1],
    );

    const again = await findOrCreateLandingLead(payload(email, 'fresh'));
    expect(again.duplicate).toBe(false);
    expect(again.lead.id).not.toBe(created.lead.id);
    expect(await rowsFor(email)).toBe(2);
  });
});
