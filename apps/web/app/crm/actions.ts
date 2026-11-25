'use server';

/**
 * Server actions for the internal CRM (docs/CONTRACTS.md §9).
 *
 * Every action: parse `FormData` → call `@poc/core` → `revalidatePath` →
 * return `ActionState` for `useActionState` to render. No client-side fetch and
 * no direct SQL: all persistence goes through `@poc/core`.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  LEAD_STATUSES,
  OPPORTUNITY_STAGES,
  createAccount,
  createOpportunity,
  isAppError,
  updateLeadStatus,
  updateOpportunity,
  type LeadStatus,
  type OpportunityStage,
} from '@poc/core';
import type { ActionState } from '@/components/action-state';

/** Trimmed string, `''` when absent. */
function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

/** Optional text: empty input means "no value", not an empty string. */
function optionalText(formData: FormData, key: string): string | null {
  const value = text(formData, key);
  return value === '' ? null : value;
}

/**
 * Turns a core `AppError` into form state. Validation details from zod are
 * already field-keyed (`{ name: 'name is required' }`), so they map directly
 * onto the inputs.
 */
function toActionState(error: unknown): ActionState {
  if (isAppError(error)) {
    const fieldErrors: Record<string, string> = {};
    if (error.details && typeof error.details === 'object') {
      for (const [key, value] of Object.entries(error.details as Record<string, unknown>)) {
        if (typeof value === 'string') fieldErrors[key] = value;
      }
    }
    return {
      error: error.message,
      ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
    };
  }
  console.error('[crm] server action failed', error);
  return { error: 'Something went wrong while saving. Please try again.' };
}

// ------------------------------------------------------------------ accounts

export async function createAccountAction(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await createAccount({
      name: text(formData, 'name'),
      industry: optionalText(formData, 'industry'),
      website: optionalText(formData, 'website'),
      billing_country: optionalText(formData, 'billing_country'),
      owner_name: optionalText(formData, 'owner_name'),
    });
  } catch (error) {
    return toActionState(error);
  }

  revalidatePath('/crm');
  revalidatePath('/crm/accounts');
  redirect('/crm/accounts');
}

// ------------------------------------------------------------- opportunities

/** Shared stage parsing — an unknown value is a form error, never a silent default. */
function parseStage(formData: FormData): { stage: OpportunityStage | undefined; error?: string } {
  const raw = text(formData, 'stage');
  if (raw === '') return { stage: undefined };
  if ((OPPORTUNITY_STAGES as readonly string[]).includes(raw)) {
    return { stage: raw as OpportunityStage };
  }
  return { stage: undefined, error: 'Choose one of the six opportunity stages' };
}

export async function createOpportunityAction(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { stage, error } = parseStage(formData);
  if (error) return { error, fieldErrors: { stage: error } };

  try {
    await createOpportunity({
      name: text(formData, 'name'),
      account_id: optionalText(formData, 'account_id'),
      stage,
      // '' is left undefined so the column default (0) applies.
      amount: text(formData, 'amount') === '' ? undefined : text(formData, 'amount'),
      close_date: optionalText(formData, 'close_date'),
      owner_name: optionalText(formData, 'owner_name'),
    });
  } catch (caught) {
    return toActionState(caught);
  }

  revalidatePath('/crm');
  revalidatePath('/crm/opportunities');
  redirect('/crm/opportunities');
}

export async function updateOpportunityAction(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = text(formData, 'id');
  if (id === '') return { error: 'Missing opportunity id' };

  const { stage, error } = parseStage(formData);
  if (error) return { error, fieldErrors: { stage: error } };

  const closeDate = optionalText(formData, 'close_date');
  if (closeDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(closeDate)) {
    return { error: 'Close date must be a valid date', fieldErrors: { close_date: 'invalid date' } };
  }

  try {
    await updateOpportunity(id, {
      stage,
      amount: text(formData, 'amount') === '' ? undefined : text(formData, 'amount'),
      close_date: closeDate,
      owner_name: optionalText(formData, 'owner_name'),
      // '' from the "No account" option unlinks the record on purpose.
      account_id: optionalText(formData, 'account_id'),
    });
  } catch (caught) {
    return toActionState(caught);
  }

  revalidatePath('/crm');
  revalidatePath('/crm/opportunities');
  revalidatePath(`/crm/opportunities/${id}`);
  return { message: 'Opportunity saved.' };
}

// --------------------------------------------------------------------- leads

export async function updateLeadStatusAction(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = text(formData, 'id');
  const status = text(formData, 'status');

  if (id === '') return { error: 'Missing lead id' };
  if (!(LEAD_STATUSES as readonly string[]).includes(status)) {
    return { error: 'Choose a valid lead status', fieldErrors: { status: 'invalid status' } };
  }

  let updatedName: string | null = null;
  try {
    const lead = await updateLeadStatus(id, status as LeadStatus);
    updatedName = lead.full_name;
  } catch (caught) {
    return toActionState(caught);
  }

  revalidatePath('/crm');
  revalidatePath('/crm/leads');
  revalidatePath(`/crm/leads/${id}`);
  return { message: `Status set to “${status}” for ${updatedName ?? 'this lead'}.` };
}
