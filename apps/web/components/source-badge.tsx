import type { EntitySource, LeadSource } from '@poc/core';
import { cn, humanize } from './format';

/**
 * The core distinction of this POC: where a row came from.
 *
 * Salesforce-synced = blue, website-captured = green, local/manual = slate
 * (docs/CONTRACTS.md §9). Rendered on every list and every detail page.
 */
const SOURCE_STYLES: Record<string, { label: string; className: string; dot: string }> = {
  salesforce: {
    label: 'Salesforce',
    className: 'bg-blue-50 text-blue-700 ring-blue-200',
    dot: 'bg-blue-500',
  },
  landing_page: {
    label: 'Website',
    className: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    dot: 'bg-emerald-500',
  },
  local: {
    label: 'Local',
    className: 'bg-slate-100 text-slate-600 ring-slate-300',
    dot: 'bg-slate-400',
  },
  manual: {
    label: 'Local',
    className: 'bg-slate-100 text-slate-600 ring-slate-300',
    dot: 'bg-slate-400',
  },
};

export function SourceBadge({
  source,
  className,
}: {
  source: EntitySource | LeadSource | null | undefined;
  className?: string;
}) {
  const style = source ? SOURCE_STYLES[source] : undefined;
  const label = style?.label ?? 'Unknown';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        style?.className ?? 'bg-slate-100 text-slate-500 ring-slate-300',
        className,
      )}
      title={`source: ${source ?? 'unknown'}`}
    >
      <span aria-hidden="true" className={cn('size-1.5 rounded-full', style?.dot ?? 'bg-slate-400')} />
      {label}
    </span>
  );
}

/** Raw enum text for cases where the badge is not wanted (e.g. detail pages). */
export function sourceLabel(source: EntitySource | LeadSource | null | undefined): string {
  if (!source) return 'Unknown';
  const style = SOURCE_STYLES[source];
  return style ? `${style.label} (${humanize(source)})` : humanize(source);
}
