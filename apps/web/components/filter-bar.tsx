import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from './format';
import { buttonSecondary } from './page-header';

/**
 * GET-form filters. No client state and no JavaScript needed: the browser
 * submits the query string and the server component re-reads it from
 * `searchParams` (docs/CONTRACTS.md §9).
 */
export function FilterBar({
  action,
  children,
  submitLabel = 'Apply',
  clearHref,
  className,
}: {
  action: string;
  children: ReactNode;
  submitLabel?: string;
  clearHref?: string;
  className?: string;
}) {
  return (
    <form
      action={action}
      method="get"
      role="search"
      className={cn('flex flex-wrap items-end gap-2', className)}
    >
      {children}
      <button type="submit" className={cn(buttonSecondary, 'px-3 py-1.5 text-xs')}>
        {submitLabel}
      </button>
      {clearHref ? (
        <Link href={clearHref} className="px-1 py-1.5 text-xs text-slate-500 hover:text-slate-800">
          Clear
        </Link>
      ) : null}
    </form>
  );
}

const CONTROL =
  'rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 shadow-xs transition-colors placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1';

export function FilterText({
  name,
  label,
  defaultValue,
  placeholder,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="sr-only">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type="search"
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder ?? label}
        className={cn(CONTROL, 'w-56')}
      />
    </div>
  );
}

export interface FilterOption {
  value: string;
  label: string;
}

export function FilterSelect({
  name,
  label,
  value,
  options,
  allLabel,
}: {
  name: string;
  label: string;
  value?: string;
  options: FilterOption[];
  allLabel: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="sr-only">
        {label}
      </label>
      <select id={name} name={name} defaultValue={value ?? ''} className={cn(CONTROL, 'pr-8')}>
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
