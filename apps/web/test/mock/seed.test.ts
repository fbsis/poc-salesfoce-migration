/**
 * `POST /mock/seed` semantics (docs/CONTRACTS.md §6).
 *
 * The mock's store is shared by every suite and by the running demo, so the
 * endpoint's contract *is* the determinism contract: seeding must produce a
 * dataset, not an increment. This file pins that down and then puts the
 * canonical demo dataset back, so it can run at any point in the suite.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { CANONICAL_COUNTS, canonicalDataset } from '../fixtures/canonical';
import { mockHealth, mockState, resetMock, seedMock } from '../e2e/helpers';

const ZERO = { accounts: 0, contacts: 0, opportunities: 0, leads: 0 };

/** A one-account dataset, so "replaced" and "merged" are different numbers. */
function oneAccount(id: string, name: string) {
  return {
    accounts: [
      {
        Id: id,
        Name: name,
        Industry: 'Residential Real Estate',
        BillingCountry: 'United States',
        IsDeleted: false,
      },
    ],
  };
}

afterAll(async () => {
  // Leave the demo dataset behind, whatever the assertions above did.
  await seedMock(canonicalDataset());
});

describe('POST /mock/seed', () => {
  it('replaces the dataset by default (a seed is a snapshot, not an increment)', async () => {
    await seedMock(oneAccount('001VITESTSEEDAAAA', 'VITEST seed one'));
    expect((await mockHealth()).dataset).toEqual({ ...ZERO, accounts: 1 });

    const second = await seedMock(oneAccount('001VITESTSEEDBBBB', 'VITEST seed two'));
    expect(second.mode).toBe('replace');
    expect(second.counts).toEqual({ ...ZERO, accounts: 1 });

    // The first seed's row is gone: the dataset is exactly what was sent.
    const state = await mockState();
    expect(state.dataset.accounts.map((row) => String(row.Id))).toEqual(['001VITESTSEEDBBBB']);
    // Objects that were not sent are emptied rather than kept.
    expect(state.dataset.contacts).toEqual([]);
    expect(state.dataset.opportunities).toEqual([]);
    expect(state.dataset.leads).toEqual([]);
  });

  it("adds to the dataset with {\"mode\":\"merge\"}", async () => {
    const canonical = canonicalDataset();
    await seedMock(canonical);

    const merged = await seedMock(oneAccount('001VITESTMERGAAAA', 'VITEST merged account'), {
      mode: 'merge',
    });
    expect(merged.mode).toBe('merge');
    expect(merged.counts).toEqual({ ...CANONICAL_COUNTS, accounts: CANONICAL_COUNTS.accounts + 1 });

    // The canonical rows survived the merge; only accounts grew.
    const state = await mockState();
    const accountIds = state.dataset.accounts.map((row) => String(row.Id));
    for (const id of canonical.accounts.map((row) => String(row.Id))) {
      expect(accountIds).toContain(id);
    }
    expect(state.dataset.contacts.length).toBe(CANONICAL_COUNTS.contacts);
    expect(state.dataset.opportunities.length).toBe(CANONICAL_COUNTS.opportunities);
    expect(state.dataset.leads.length).toBe(CANONICAL_COUNTS.leads);

    // A merge with an existing id overwrites that row (it is a new snapshot).
    const renamed = await seedMock(oneAccount(canonical.accounts[0].Id, 'VITEST rename check'), {
      mode: 'merge',
    });
    expect(renamed.counts.accounts).toBe(CANONICAL_COUNTS.accounts + 1);
    const renamedRow = (await mockState()).dataset.accounts.find(
      (row) => String(row.Id) === String(canonical.accounts[0].Id),
    );
    expect(renamedRow?.Name).toBe('VITEST rename check');
  });

  it('still clears everything with /mock/reset', async () => {
    await seedMock(canonicalDataset());
    const reset = await resetMock();
    expect(reset.counts).toEqual(ZERO);
    expect(reset.events).toBe(0);
    expect((await mockState()).counts).toEqual(ZERO);
  });
});
