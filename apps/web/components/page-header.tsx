import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from './format';

/** Sticky page header shared by every CRM screen. */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 mb-5 border-b border-slate-200 bg-slate-50/95 py-4 backdrop-blur-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-xs font-semibold uppercase tracking-widest text-brand-600">{eyebrow}</p>
          ) : null}
          <h1 className="mt-0.5 truncate text-xl font-semibold tracking-tight text-slate-900">
            {title}
          </h1>
          {description ? <p className="mt-1 max-w-2xl text-sm text-slate-500">{description}</p> : null}
          {meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

const BUTTON_BASE =
  'inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed';

/** Primary action styling, exported so forms and links stay identical. */
export const buttonPrimary = cn(
  BUTTON_BASE,
  'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-500/60',
);

export const buttonSecondary = cn(
  BUTTON_BASE,
  'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
);

/** Small "New …" action that keeps header markup consistent. */
export function HeaderAction({
  href,
  children,
  variant = 'primary',
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <Link href={href} className={variant === 'primary' ? buttonPrimary : buttonSecondary}>
      {children}
    </Link>
  );
}
