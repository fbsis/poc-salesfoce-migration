import Link from 'next/link';
import { listOpportunities, type OpportunityStage } from '@poc/core';
import { DataTable, TableCell, TableRow } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { FilterBar, FilterText } from '@/components/filter-bar';
import { PageHeader, HeaderAction } from '@/components/page-header';
import { PageTotals } from '@/components/page-totals';
import { SourceBadge } from '@/components/source-badge';
import { StagePill } from '@/components/status-pill';
import { STAGES } from '@/components/enums';
import { cn, formatDate, formatMoney, shortId } from '@/components/format';
import { buildQuery, readParam, type SearchParamValue } from '@/components/search-params';

export const dynamic = 'force-dynamic';

function parseStage(raw: string): OpportunityStage | undefined {
  return (STAGES as readonly string[]).includes(raw) ? (raw as OpportunityStage) : undefined;
}

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: SearchParamValue; stage?: SearchParamValue }>;
}) {
  const params = await searchParams;
  const search = readParam(params.search);
  const stageParam = readParam(params.stage);
  const stage = parseStage(stageParam);

  const opportunities = await listOpportunities({
    ...(search === '' ? {} : { search }),
    ...(stage ? { stage } : {}),
    limit: 100,
  });

  const withoutStage = buildQuery({ search: search || undefined });
  const filtered = search !== '' || stage !== undefined;

  return (
    <>
      <PageHeader
        eyebrow="CRM"
        title="Opportunities"
        description="Pipeline by stage, priced in USD. Stage filters are plain links so they work without JavaScript."
        actions={<HeaderAction href="/crm/opportunities/new">New opportunity</HeaderAction>}
      />

      <nav aria-label="Filter opportunities by stage" className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Stage</span>
        <Link
          href={`/crm/opportunities${withoutStage}`}
          aria-current={stage === undefined ? 'true' : undefined}
          className={cn(
            'rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
            stage === undefined
              ? 'bg-brand-600 text-white ring-brand-600'
              : 'bg-white text-slate-600 ring-slate-300 hover:bg-slate-50',
          )}
        >
          All stages
        </Link>
        {STAGES.map((option) => {
          const href = `/crm/opportunities${buildQuery({ search: search || undefined, stage: option })}`;
          const active = stage === option;
          return (
            <Link
              key={option}
              href={href}
              aria-current={active ? 'true' : undefined}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
                active
                  ? 'bg-brand-600 text-white ring-brand-600'
                  : 'bg-white text-slate-600 ring-slate-300 hover:bg-slate-50',
              )}
            >
              {option}
            </Link>
          );
        })}
      </nav>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterBar
          action="/crm/opportunities"
          submitLabel="Search"
          clearHref={filtered ? '/crm/opportunities' : undefined}
        >
          <FilterText
            name="search"
            label="Search opportunities by name"
            defaultValue={search}
            placeholder="Search opportunities…"
          />
          {stage ? <input type="hidden" name="stage" value={stage} /> : null}
        </FilterBar>
        <PageTotals total={opportunities.total} noun={stage ? `${stage} opportunity` : 'opportunity'} />
      </div>

      {opportunities.data.length === 0 ? (
        <EmptyState
          title={
            filtered
              ? 'No opportunities match these filters'
              : 'No opportunities yet'
          }
          description={
            filtered
              ? 'Clear the search or choose another stage.'
              : 'Create one locally, or run the Salesforce bulk extract to pull the pipeline across.'
          }
          action={
            filtered ? (
              <Link href="/crm/opportunities" className="text-sm font-medium text-brand-600 hover:text-brand-700">
                Clear filters
              </Link>
            ) : (
              <Link
                href="/crm/opportunities/new"
                className="text-sm font-medium text-brand-600 hover:text-brand-700"
              >
                Create the first opportunity
              </Link>
            )
          }
        />
      ) : (
        <DataTable
          caption="Opportunities with stage, amount, close date, account and source"
          columns={[
            { label: 'Opportunity' },
            { label: 'Account' },
            { label: 'Stage' },
            { label: 'Amount', align: 'right' },
            { label: 'Close date', align: 'right' },
            { label: 'Source' },
          ]}
          footer={<span>{opportunities.total} opportunities in this view</span>}
        >
          {opportunities.data.map((opportunity) => (
            <TableRow key={opportunity.id}>
              <TableCell>
                <Link
                  href={`/crm/opportunities/${opportunity.id}`}
                  className="font-medium text-slate-900 hover:text-brand-600"
                >
                  {opportunity.name}
                </Link>
                <p className="text-xs text-slate-400" title={opportunity.id}>
                  {shortId(opportunity.id)}
                </p>
              </TableCell>
              <TableCell>
                {opportunity.account_id ? (
                  <Link
                    href={`/crm/accounts/${opportunity.account_id}`}
                    className="text-slate-700 hover:text-brand-600"
                  >
                    {opportunity.account_name ?? shortId(opportunity.account_id)}
                  </Link>
                ) : (
                  <span className="text-slate-400">No account</span>
                )}
              </TableCell>
              <TableCell>
                <StagePill stage={opportunity.stage} />
              </TableCell>
              <TableCell align="right" className="font-medium text-slate-900">
                {formatMoney(opportunity.amount)}
              </TableCell>
              <TableCell align="right" className="whitespace-nowrap text-xs text-slate-500">
                {formatDate(opportunity.close_date)}
              </TableCell>
              <TableCell>
                <SourceBadge source={opportunity.source} />
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </>
  );
}
