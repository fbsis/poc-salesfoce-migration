import type { ReactNode } from 'react';

/**
 * Calm zero-state used whenever a list, card or dashboard block has no rows.
 * Every CRM screen renders one of these instead of an empty box or a crash.
 */
export function EmptyState({
  title,
  description,
  action,
  compact = false,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact
          ? 'px-4 py-8 text-center'
          : 'rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center'
      }
    >
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description ? <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
