'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from './format';

const NAV_ITEMS = [
  { href: '/crm', label: 'Dashboard' },
  { href: '/crm/accounts', label: 'Accounts' },
  { href: '/crm/contacts', label: 'Contacts' },
  { href: '/crm/opportunities', label: 'Opportunities' },
  { href: '/crm/leads', label: 'Leads' },
] as const;

/** `/crm` must not highlight itself for every nested route. */
function isActive(pathname: string, href: string): boolean {
  if (href === '/crm') return pathname === '/crm';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * CRM navigation. One list, two layouts: a horizontal scrollable bar under
 * `md` (inside the header) and a vertical sidebar from `md` up.
 */
export function CrmNav({ variant }: { variant: 'top' | 'side' }) {
  const pathname = usePathname() ?? '/crm';

  return (
    <nav
      aria-label={variant === 'top' ? 'CRM sections (compact)' : 'CRM sections'}
      className={cn(
        variant === 'top'
          ? 'flex gap-1 overflow-x-auto border-t border-slate-200 px-2 py-2 md:hidden'
          : 'hidden flex-col gap-1 md:flex',
      )}
    >
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1',
              variant === 'side' && 'block',
              active
                ? 'bg-brand-50 text-brand-700'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
