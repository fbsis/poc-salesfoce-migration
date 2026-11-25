'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import type { Opportunity } from '@poc/core';
import { createOpportunityAction, updateOpportunityAction } from '@/app/crm/actions';
import { FormFeedback, SelectField, TextField } from './form-field';
import { INITIAL_ACTION_STATE, fieldError, type ActionState } from './action-state';
import { SubmitButton } from './submit-button';
import { buttonSecondary } from './page-header';
import { STAGE_OPTIONS } from './enums';
import { cn } from './format';

export interface AccountOption {
  id: string;
  name: string;
}

function accountOptions(accounts: AccountOption[]): Array<{ value: string; label: string }> {
  return accounts.map((account) => ({ value: account.id, label: account.name }));
}

function StageField({ state, defaultValue }: { state: ActionState; defaultValue?: string }) {
  return (
    <SelectField
      label="Stage"
      name="stage"
      options={STAGE_OPTIONS}
      defaultValue={defaultValue ?? 'Prospecting'}
      error={fieldError(state, 'stage')}
      hint="One of the six Salesforce opportunity stages."
    />
  );
}

/** Shared field grid for both create and edit. */
function OpportunityFields({
  state,
  accounts,
  opportunity,
}: {
  state: ActionState;
  accounts: AccountOption[];
  opportunity?: Opportunity;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <TextField
          label="Opportunity name"
          name="name"
          required
          defaultValue={opportunity?.name}
          placeholder="Sunset Villas — 12 unit block"
          error={fieldError(state, 'name')}
        />
      </div>
      <StageField state={state} defaultValue={opportunity?.stage} />
      <TextField
        label="Amount (USD)"
        name="amount"
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        defaultValue={opportunity?.amount ?? ''}
        placeholder="450000"
        error={fieldError(state, 'amount')}
      />
      <TextField
        label="Close date"
        name="close_date"
        type="date"
        defaultValue={opportunity?.close_date ?? ''}
        error={fieldError(state, 'close_date')}
      />
      <TextField
        label="Owner"
        name="owner_name"
        defaultValue={opportunity?.owner_name ?? ''}
        placeholder="Dana Whitfield"
        error={fieldError(state, 'owner_name')}
      />
      <div className="sm:col-span-2">
        <SelectField
          label="Account"
          name="account_id"
          options={accountOptions(accounts)}
          defaultValue={opportunity?.account_id ?? ''}
          placeholder="No account"
          error={fieldError(state, 'account_id')}
          hint={
            accounts.length === 0
              ? 'No accounts yet — create one first to link this opportunity.'
              : undefined
          }
        />
      </div>
    </div>
  );
}

export function OpportunityCreateForm({ accounts }: { accounts: AccountOption[] }) {
  const [state, formAction] = useActionState(createOpportunityAction, INITIAL_ACTION_STATE);

  return (
    <form action={formAction} className="space-y-4">
      <FormFeedback error={state.error} />
      <OpportunityFields state={state} accounts={accounts} />
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
        <SubmitButton pendingLabel="Creating…">Create opportunity</SubmitButton>
        <Link href="/crm/opportunities" className={cn(buttonSecondary)}>
          Cancel
        </Link>
      </div>
    </form>
  );
}

export function OpportunityEditForm({
  opportunity,
  accounts,
}: {
  opportunity: Opportunity;
  accounts: AccountOption[];
}) {
  const [state, formAction] = useActionState(updateOpportunityAction, INITIAL_ACTION_STATE);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="id" value={opportunity.id} />
      <FormFeedback error={state.error} message={state.message} />
      <OpportunityFields state={state} accounts={accounts} opportunity={opportunity} />
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
        <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
        <p className="text-xs text-slate-500">
          Stage, amount, close date and owner go through{' '}
          <code className="text-slate-700">updateOpportunity()</code>.
        </p>
      </div>
    </form>
  );
}
