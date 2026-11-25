import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from './format';

/**
 * Dashboard counter. `hint` carries the secondary number that makes the POC
 * legible (e.g. "3 from Salesforce · 1 local").
 */
export function StatCard({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: number | string;
  hint?: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums text-slate-900">{value}</p>
      {hint ? <p className="mt-2 text-xs text-slate-500">{hint}</p> : null}
    </>
  );

  const className =
    'block rounded-xl border border-slate-200 bg-white p-4 shadow-xs transition-colors';

  if (href) {
    return (
      <Link href={href} className={cn(className, 'hover:border-brand-500')}>
        {body}
      </Link>
    );
  }

  return <div className={className}>{body}</div>;
}

/** Plain white panel used by the dashboard and detail pages. */
export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('rounded-xl border border-slate-200 bg-white', className)}>
      {title ? (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
          </div>
          {actions}
        </header>
      ) : null}
      <div className={cn('px-4 py-3', bodyClassName)}>{children}</div>
    </section>
  );
}
