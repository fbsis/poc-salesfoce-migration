import Link from 'next/link';
import { listAccounts } from '@poc/core';
import { DataTable, TableCell, TableRow } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { FilterBar, FilterText } from '@/components/filter-bar';
import { PageHeader, HeaderAction } from '@/components/page-header';
import { SourceBadge } from '@/components/source-badge';
import { PageTotals } from '@/components/page-totals';
import { formatDateTime, shortId } from '@/components/format';
import { readParam, type SearchParamValue } from '@/components/search-params';

export const dynamic = 'force-dynamic';

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: SearchParamValue }>;
}) {
  const params = await searchParams;
  const search = readParam(params.search);

  const accounts = await listAccounts({
    ...(search === '' ? {} : { search }),
    limit: 100,
  });

  return (
    <>
      <PageHeader
        eyebrow="CRM"
        title="Accounts"
        description="Companies, whether they came across in the bulk extract or were created locally."
        actions={<HeaderAction href="/crm/accounts/new">New account</HeaderAction>}
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterBar action="/crm/accounts" clearHref="/crm/accounts" submitLabel="Search">
          <FilterText
            name="search"
            label="Search accounts by name"
            defaultValue={search}
            placeholder="Search name…"
          />
        </FilterBar>
        <PageTotals total={accounts.total} noun="account" />
      </div>

      {accounts.data.length === 0 ? (
        <EmptyState
          title={search ? `No accounts match “${search}”` : 'No accounts yet'}
          description={
            search
              ? 'Try a different name, or clear the filter.'
              : 'Create an account locally, or run the Salesforce bulk extract to pull them in.'
          }
          action={
            search ? (
              <Link href="/crm/accounts" className="text-sm font-medium text-brand-600 hover:text-brand-700">
                Clear search
              </Link>
            ) : (
              <Link
                href="/crm/accounts/new"
                className="text-sm font-medium text-brand-600 hover:text-brand-700"
              >
                Create the first account
              </Link>
            )
          }
        />
      ) : (
        <DataTable
          caption="Accounts, with industry, owner, source and last update"
          columns={[
            { label: 'Account' },
            { label: 'Industry' },
            { label: 'Owner' },
            { label: 'Source' },
            { label: 'Updated', align: 'right' },
          ]}
          footer={
            <span>
              {accounts.total} accounts · ids are local UUIDs (hover for the full value) unless the row
              came from Salesforce
            </span>
          }
        >
          {accounts.data.map((account) => (
            <TableRow key={account.id}>
              <TableCell>
                <Link
                  href={`/crm/accounts/${account.id}`}
                  className="font-medium text-slate-900 hover:text-brand-600"
                >
                  {account.name}
                </Link>
                <p className="text-xs text-slate-400" title={account.id}>
                  {shortId(account.id)}
                </p>
              </TableCell>
              <TableCell>{account.industry ?? <span className="text-slate-400">—</span>}</TableCell>
              <TableCell>{account.owner_name ?? <span className="text-slate-400">—</span>}</TableCell>
              <TableCell>
                <SourceBadge source={account.source} />
              </TableCell>
              <TableCell align="right" className="whitespace-nowrap text-xs text-slate-500">
                {formatDateTime(account.updated_at)}
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </>
  );
}
