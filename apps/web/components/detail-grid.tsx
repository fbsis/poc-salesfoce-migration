import type { ReactNode } from 'react';
import { cn } from './format';

export interface DetailItem {
  label: string;
  value: ReactNode;
  /** Let a long value (message, id) use the full row. */
  wide?: boolean;
}

/**
 * Label/value pairs on detail pages. Keeps every entity page visually
 * consistent and gives assistive tech a real definition list.
 */
export function DetailGrid({ items, className }: { items: DetailItem[]; className?: string }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {items.map((item) => (
        <div key={item.label} className={cn(item.wide && 'sm:col-span-2 lg:col-span-3')}>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{item.label}</dt>
          <dd className="mt-1 break-words text-sm text-slate-800">
            {item.value === null || item.value === undefined || item.value === '' ? (
              <span className="text-slate-400">—</span>
            ) : (
              item.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
