'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { createAccountAction } from '@/app/crm/actions';
import { FormFeedback, TextField } from './form-field';
import { INITIAL_ACTION_STATE, fieldError } from './action-state';
import { SubmitButton } from './submit-button';
import { buttonSecondary } from './page-header';
import { cn } from './format';

/**
 * Account creation form. The action redirects on success, so only errors need
 * to be rendered (`useActionState` state).
 */
export function AccountCreateForm() {
  const [state, formAction] = useActionState(createAccountAction, INITIAL_ACTION_STATE);

  return (
    <form action={formAction} className="space-y-4">
      <FormFeedback error={state.error} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <TextField
            label="Account name"
            name="name"
            required
            placeholder="Acme Real Estate"
            error={fieldError(state, 'name')}
            autoComplete="organization"
          />
        </div>
        <TextField
          label="Industry"
          name="industry"
          placeholder="Real estate"
          error={fieldError(state, 'industry')}
        />
        <TextField
          label="Owner"
          name="owner_name"
          placeholder="Dana Whitfield"
          error={fieldError(state, 'owner_name')}
        />
        <TextField
          label="Website"
          name="website"
          type="url"
          placeholder="https://example.com"
          error={fieldError(state, 'website')}
        />
        <TextField
          label="Billing country"
          name="billing_country"
          placeholder="United States"
          error={fieldError(state, 'billing_country')}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
        <SubmitButton pendingLabel="Creating…">Create account</SubmitButton>
        <Link href="/crm/accounts" className={cn(buttonSecondary)}>
          Cancel
        </Link>
        <p className="text-xs text-slate-500">
          Locally created accounts are stored with <code className="text-slate-700">source = local</code>
          ; they only appear in Salesforce after a sync write-back (out of scope for this POC).
        </p>
      </div>
    </form>
  );
}
