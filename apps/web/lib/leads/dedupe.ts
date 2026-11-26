/**
 * Atomic "find an existing landing-page lead, else create one" — the write half
 * of docs/CONTRACTS.md §5 duplicate handling.
 *
 * Why this file exists (AUDIT P1-5): the endpoint used to do
 * `findDuplicate()` → `createLead()` in two separate statements, so two
 * concurrent submissions of the same email both saw "no duplicate" and both
 * inserted. `db/migrations` has no unique index on email (leads from different
 * sources legitimately share an address), so the database will not catch it
 * either.
 *
 * The fix is a **transaction-scoped advisory lock** on the lower-cased email:
 * `pg_advisory_xact_lock(hashtext(lower(email)))` makes every request for the
 * same address queue up, the winner re-checks under the lock, and losers see
 * the row the winner committed and return it instead of inserting. The lock is
 * released by COMMIT/ROLLBACK — no leak path, no cleanup job. `hashtext` is a
 * 32-bit hash, so unrelated addresses occasionally serialise for a millisecond;
 * that is harmless (it never produces a wrong answer).
 *
 * DELIBERATE EXCEPTION to the "no SQL in the app" convention (§0.7): this is
 * the one place where atomicity cannot be expressed through the `@poc/core`
 * service API — the service exposes single-statement operations only, and the
 * lock must wrap the check *and* the insert. The SQL here is confined to the
 * lock and to a read-only existence probe; the row itself is still created by
 * `createLead`, so validation, defaults (`source`/`status`/`consent_at`) and
 * row mapping stay in one place.
 */
import { createLead, getLead, withTransaction, type CreateLeadInput, type Lead } from '@poc/core';

/** A landing-page lead created within this window is "the same submission". */
export const DUPLICATE_WINDOW_HOURS = 24;

const SOURCE = 'landing_page' as const;

export interface FindOrCreateResult {
  /** The existing (duplicate) row or the freshly inserted one. */
  lead: Lead;
  /** `true` when nothing was inserted. */
  duplicate: boolean;
}

/**
 * Find a `source='landing_page'` lead for `input.email` created in the last
 * 24 h; otherwise insert one through `createLead`. Concurrent calls with the
 * same email produce exactly one row: every loser returns it with
 * `duplicate: true`.
 *
 * Note on `createLead` inside the transaction: it runs on a pooled connection
 * of its own and therefore autocommits. That is safe here — the advisory lock
 * is what serialises the callers, and a committed insert is visible to the
 * next holder of the lock, while a failed insert releases the lock through
 * ROLLBACK. (Nesting the pool query into this transaction would require a
 * `PoolClient`-aware service API, which §0.7 does not provide.)
 */
export async function findOrCreateLandingLead(input: CreateLeadInput): Promise<FindOrCreateResult> {
  const email = String(input.email ?? '').trim().toLowerCase();

  return withTransaction(async (client) => {
    if (email !== '') {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
    }

    // Re-check under the lock: this read is the authoritative one.
    const existing = await client.query<{ id: string }>(
      `SELECT id
         FROM leads
        WHERE lower(email) = $1
          AND source = $2
          AND created_at > now() - ($3::int * interval '1 hour')
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [email, SOURCE, DUPLICATE_WINDOW_HOURS],
    );

    const id = existing.rows[0]?.id;
    if (id) return { lead: await getLead(id), duplicate: true };

    const lead = await createLead({
      ...input,
      email,
      source: SOURCE,
      status: input.status ?? 'new',
    });
    return { lead, duplicate: false };
  });
}
