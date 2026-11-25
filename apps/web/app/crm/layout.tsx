import Link from 'next/link';
import { CrmNav } from '@/components/crm-nav';
import { buttonSecondary } from '@/components/page-header';
import { cn } from '@/components/format';

/**
 * Persistent CRM shell: brand bar, navigation and the content column.
 *
 * Navigation is a vertical sidebar from `md` up and collapses into a
 * horizontally scrollable bar inside the header below `md`.
 */
export default function CrmLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Link
              href="/crm"
              className="rounded-lg bg-brand-600 px-2 py-1 text-xs font-bold tracking-wide text-white transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
            >
              POC
            </Link>
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-brand-600">
                POC · Salesforce migration
              </p>
              <p className="text-sm font-semibold text-slate-900">Internal CRM</p>
            </div>
          </div>
          <Link href="/lead" className={cn(buttonSecondary, 'text-xs')}>
            Public lead page
          </Link>
        </div>
        <CrmNav variant="top" />
      </header>

      <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6 sm:px-6">
        <aside className="hidden w-44 shrink-0 md:block">
          <CrmNav variant="side" />
          <div className="mt-6 rounded-lg border border-slate-200 bg-white p-3">
            <p className="text-xs font-semibold text-slate-700">Sources</p>
            <ul className="mt-2 space-y-1.5 text-xs text-slate-500">
              <li>Salesforce-synced rows</li>
              <li>Website-captured leads</li>
              <li>Locally created rows</li>
            </ul>
            <p className="mt-2 text-xs text-slate-400">
              Every table badges the origin so the migration stays visible.
            </p>
          </div>
        </aside>

        <main className="min-w-0 flex-1 pb-12">{children}</main>
      </div>
    </div>
  );
}
