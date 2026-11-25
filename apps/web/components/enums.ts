import type { LeadStatus, OpportunityStage } from '@poc/core';

/**
 * Client-safe copies of the enum lists.
 *
 * Client components must not pull *values* out of `@poc/core` (that would drag
 * `pg` into the browser bundle), so the literal lists live here with `import
 * type` only — and `packages/core` remains the source of truth for validation.
 */
export const STAGES: readonly OpportunityStage[] = [
  'Prospecting',
  'Qualification',
  'Proposal',
  'Negotiation',
  'Closed Won',
  'Closed Lost',
];

export const STAGE_OPTIONS: Array<{ value: OpportunityStage; label: OpportunityStage }> = STAGES.map(
  (stage) => ({ value: stage, label: stage }),
);

export const LEAD_STATUS_OPTIONS: Array<{ value: LeadStatus; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'closed', label: 'Closed' },
];
