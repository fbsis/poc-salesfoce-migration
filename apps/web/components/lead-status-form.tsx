'use client';

import { useActionState } from 'react';
import type { Lead } from '@poc/core';
import { updateLeadStatusAction } from '@/app/crm/actions';
import { FormFeedback } from './form-field';
import { SubmitButton } from './submit-button';
import { INITIAL_ACTION_STATE, fieldError } from './action-state';
import { LEAD_STATUS_OPTIONS } from './enums';
import { cn } from './format';
import { LeadStatusPill } from './status-pill';

/**
 * Four explicit status buttons — one submit each, so a single click moves the
 * lead through the funnel. The action returns a confirmation message that is
 * announced through `aria-live`.
 */
export function LeadStatusForm({ lead }: { lead: Lead }) {
  const [state, formAction] = useActionState(updateLeadStatusAction, INITIAL_ACTION_STATE);
  const statusError = fieldError(state, 'status');

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="id" value={lead.id} />

      <fieldset aria-describedby={statusError ? 'status-error' : undefined}>
        <legend className="text-xs font-semibold text-slate-700">
          Set status
          <span aria-hidden="true" className="ml-0.5 text-rose-600">
            *
          </span>
        </legend>
        <p className="mt-1 flex items-center gap-2 text-xs text-slate-500">
          Current: <LeadStatusPill status={lead.status} />
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {LEAD_STATUS_OPTIONS.map((option) => {
            const active = option.value === lead.status;
            return (
              <SubmitButton
                key={option.value}
                name="status"
                value={option.value}
                variant="secondary"
                pendingLabel="Updating…"
                className={cn(active && 'border-brand-500 bg-brand-50 text-brand-700')}
                title={`Mark this lead as ${option.label.toLowerCase()}`}
              >
                {active ? `${option.label} · current` : option.label}
              </SubmitButton>
            );
          })}
        </div>
        {statusError ? (
          <p id="status-error" className="mt-1 text-xs font-medium text-rose-600">
            {statusError}
          </p>
        ) : null}
      </fieldset>

      <FormFeedback error={state.error} message={state.message} />
    </form>
  );
}
