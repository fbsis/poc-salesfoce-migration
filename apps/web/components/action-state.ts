/**
 * Shape returned by every CRM server action (`app/crm/actions.ts`).
 *
 * It is the `useActionState` state, so it must be a plain serialisable object.
 */
export interface ActionState {
  /** Form-level message shown in the `aria-live` region. */
  error?: string;
  /** Success confirmation (lead status update, opportunity edit). */
  message?: string;
  /** Field-keyed validation messages, straight from `AppError.details`. */
  fieldErrors?: Record<string, string>;
}

export const INITIAL_ACTION_STATE: ActionState = {};

/** Reads a field error, tolerating the `_` key zod uses for object-level issues. */
export function fieldError(state: ActionState, name: string): string | undefined {
  return state.fieldErrors?.[name];
}
