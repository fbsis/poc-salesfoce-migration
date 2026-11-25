import type { ReactNode } from 'react';
import { cn } from './format';

const CONTROL =
  'w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-xs transition-colors placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 disabled:bg-slate-50';

function controlClass(error?: string): string {
  return cn(CONTROL, error ? 'border-rose-400' : 'border-slate-300');
}

function describedBy(name: string, error?: string, hint?: string): string | undefined {
  const ids = [error ? `${name}-error` : null, hint ? `${name}-hint` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

function Label({
  htmlFor,
  children,
  required,
}: {
  htmlFor: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-xs font-semibold text-slate-700">
      {children}
      {required ? (
        <span aria-hidden="true" className="ml-0.5 text-rose-600">
          *
        </span>
      ) : null}
    </label>
  );
}

function FieldMessages({ name, error, hint }: { name: string; error?: string; hint?: string }) {
  return (
    <>
      {hint ? (
        <p id={`${name}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${name}-error`} className="mt-1 text-xs font-medium text-rose-600">
          {error}
        </p>
      ) : null}
    </>
  );
}

export function TextField({
  label,
  name,
  defaultValue,
  error,
  hint,
  required,
  type = 'text',
  placeholder,
  autoComplete,
  inputMode,
  step,
  min,
  max,
}: {
  label: string;
  name: string;
  defaultValue?: string | number | null;
  error?: string;
  hint?: string;
  required?: boolean;
  type?: 'text' | 'email' | 'url' | 'tel' | 'number' | 'date';
  placeholder?: string;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'email' | 'tel';
  step?: string;
  min?: string;
  max?: string;
}) {
  return (
    <div>
      <Label htmlFor={name} required={required}>
        {label}
      </Label>
      <input
        id={name}
        name={name}
        type={type}
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        step={step}
        min={min}
        max={max}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(name, error, hint)}
        className={cn('mt-1', controlClass(error))}
      />
      <FieldMessages name={name} error={error} hint={hint} />
    </div>
  );
}

export function TextAreaField({
  label,
  name,
  defaultValue,
  error,
  hint,
  rows = 4,
  placeholder,
}: {
  label: string;
  name: string;
  defaultValue?: string | null;
  error?: string;
  hint?: string;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <div>
      <Label htmlFor={name}>{label}</Label>
      <textarea
        id={name}
        name={name}
        rows={rows}
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(name, error, hint)}
        className={cn('mt-1', controlClass(error))}
      />
      <FieldMessages name={name} error={error} hint={hint} />
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export function SelectField({
  label,
  name,
  options,
  defaultValue,
  error,
  hint,
  required,
  placeholder,
}: {
  label: string;
  name: string;
  options: SelectOption[];
  defaultValue?: string | null;
  error?: string;
  hint?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <Label htmlFor={name} required={required}>
        {label}
      </Label>
      <select
        id={name}
        name={name}
        defaultValue={defaultValue ?? ''}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(name, error, hint)}
        className={cn('mt-1', controlClass(error))}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldMessages name={name} error={error} hint={hint} />
    </div>
  );
}

/**
 * Form-level feedback. `aria-live="polite"` so screen readers hear validation
 * errors and confirmations from server actions.
 */
export function FormFeedback({
  error,
  message,
  className,
}: {
  error?: string;
  message?: string;
  className?: string;
}) {
  return (
    <div aria-live="polite" className={cn('min-h-0 text-sm', className)}>
      {error ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">{error}</p>
      ) : null}
      {!error && message ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-700">
          {message}
        </p>
      ) : null}
    </div>
  );
}
