import Link from 'next/link';
import {
  getOpportunitiesByStage,
  getSalesSummary,
  getSyncStatus,
  listLeads,
} from '@poc/core';
import { Card, StatCard } from '@/components/stat-card';
import { DataTable, TableCell, TableRow } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeader, buttonSecondary } from '@/components/page-header';
import { SourceBadge } from '@/components/source-badge';
import { LeadStatusPill, StagePill } from '@/components/status-pill';
import { cn, formatDateTime, formatLag, formatMoney, shortId } from '@/components/format';

// The dashboard aggregates live data; never prerender it at build time.
export const dynamic = 'force-dynamic';

export default async function CrmDashboardPage() {
  const [summary, byStage, sync, recentLeads] = await Promise.all([
    getSalesSummary(),
    getOpportunitiesByStage(),
    getSyncStatus(),
    listLeads({ limit: 5 }),
  ]);

  const totalRecords = summary.salesforceRecords + summary.localRecords;
  const totalLeads = summary.leads;
  const stageMax = Math.max(...byStage.map((row) => row.totalAmount), 1);
  const stagesWithData = byStage.filter((row) => row.count > 0);

  return (
    <>
      <PageHeader
        eyebrow="Internal CRM"
        title="Dashboard"
        description="Everything captured locally, everything synced from Salesforce, and the state of the sync itself."
        meta={
          <span className="text-xs text-slate-500">
            {totalRecords} records total · {summary.salesforceRecords} from Salesforce ·{' '}
            {summary.localRecords} local
          </span>
        }
        actions={
          <>
            <Link href="/crm/accounts/new" className={cn(buttonSecondary, 'text-xs')}>
              New account
            </Link>
            <Link href="/crm/opportunities/new" className={cn(buttonSecondary, 'text-xs')}>
              New opportunity
            </Link>
          </>
        }
      />

      <section aria-labelledby="counts-heading">
        <h2 id="counts-heading" className="sr-only">
          Record counts
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Accounts" value={summary.accounts} href="/crm/accounts" hint="Companies in the CRM" />
          <StatCard label="Contacts" value={summary.contacts} href="/crm/contacts" hint="People at those accounts" />
          <StatCard
            label="Opportunities"
            value={summary.opportunities}
            href="/crm/opportunities"
            hint={`${summary.openOpportunities} open · ${formatMoney(summary.pipelineValue)} pipeline`}
          />
          <StatCard
            label="Leads"
            value={summary.leads}
            href="/crm/leads"
            hint={`${summary.newLeads} still new${totalLeads === 0 ? '' : ' · website + Salesforce + manual'}`}
          />
        </div>
      </section>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card
          title="Recent leads"
          description="The five most recently created leads, from any source."
          actions={
            <Link href="/crm/leads" className="text-xs font-medium text-brand-600 hover:text-brand-700">
              All leads
            </Link>
          }
          bodyClassName="px-0 py-0"
        >
          {recentLeads.data.length === 0 ? (
            <EmptyState
              compact
              title="No leads yet"
              description="Leads arrive from the public landing page or from a Salesforce sync."
            />
          ) : (
            <DataTable
              plain
              caption="Five most recent leads"
              columns={[
                { label: 'Lead' },
                { label: 'Source' },
                { label: 'Status' },
                { label: 'Created', align: 'right' },
              ]}
            >
              {recentLeads.data.map((lead) => (
                <TableRow key={lead.id}>
                  <TableCell>
                    <Link
                      href={`/crm/leads/${lead.id}`}
                      className="font-medium text-slate-900 hover:text-brand-600"
                    >
                      {lead.full_name}
                    </Link>
                    <p className="text-xs text-slate-500">{lead.email}</p>
                  </TableCell>
                  <TableCell>
                    <SourceBadge source={lead.source} />
                  </TableCell>
                  <TableCell>
                    <LeadStatusPill status={lead.status} />
                  </TableCell>
                  <TableCell align="right" className="whitespace-nowrap text-xs text-slate-500">
                    {formatDateTime(lead.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </DataTable>
          )}
        </Card>

        <div className="space-y-5">
          <Card
            title="Opportunities by stage"
            description="Count and value per stage — the pipeline the migration has to preserve."
          >
            {stagesWithData.length === 0 ? (
              <EmptyState
                compact
                title="No opportunities yet"
                description="Create one from an account, or let the bulk extract bring them across."
              />
            ) : (
              <ul className="space-y-3">
                {byStage.map((row) => {
                  const width = row.totalAmount > 0 ? Math.max(2, Math.round((row.totalAmount / stageMax) * 100)) : 0;
                  return (
                    <li key={row.stage}>
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <StagePill stage={row.stage} />
                        <span className="text-xs tabular-nums text-slate-500">
                          {row.count} {row.count === 1 ? 'deal' : 'deals'} ·{' '}
                          <span className="font-medium text-slate-700">{formatMoney(row.totalAmount)}</span>
                        </span>
                      </div>
                      <div
                        className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100"
                        role="presentation"
                      >
                        <div className="h-full rounded-full bg-brand-500" style={{ width: `${width}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card
            title="Salesforce sync"
            description="Bulk extract and CDC stream health."
            actions={
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                  sync.running
                    ? 'bg-amber-50 text-amber-700 ring-amber-200'
                    : 'bg-slate-100 text-slate-600 ring-slate-300',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn('size-1.5 rounded-full', sync.running ? 'bg-amber-500' : 'bg-slate-400')}
                />
                {sync.running ? 'Run in progress' : 'Idle'}
              </span>
            }
          >
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Last bulk extract
                </p>
                <p className="mt-0.5 text-slate-700">
                  {sync.lastBulkRun ? (
                    <>
                      <span className="font-medium capitalize">{sync.lastBulkRun.status}</span> ·{' '}
                      {sync.lastBulkRun.records_read} read / {sync.lastBulkRun.records_written} written ·{' '}
                      {formatDateTime(sync.lastBulkRun.finished_at ?? sync.lastBulkRun.started_at)}
                      {sync.lastBulkRun.error ? (
                        <span className="mt-1 block text-xs text-rose-600">{sync.lastBulkRun.error}</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-slate-500">No bulk extract has run yet.</span>
                  )}
                </p>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Last CDC event
                </p>
                <p className="mt-0.5 text-slate-700">
                  {sync.lastCdcEventAt ? formatDateTime(sync.lastCdcEventAt) : 'No CDC events applied yet.'}
                  <span className="ml-2 text-xs text-slate-500">lag {formatLag(sync.lagSeconds)}</span>
                </p>
              </div>

              <div className="grid grid-cols-3 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-center">
                <div>
                  <p className="text-lg font-semibold tabular-nums text-slate-900">
                    {sync.counts.cdcEvents}
                  </p>
                  <p className="text-xs text-slate-500">CDC events</p>
                </div>
                <div>
                  <p className="text-lg font-semibold tabular-nums text-slate-900">
                    {sync.counts.failedEvents}
                  </p>
                  <p className="text-xs text-slate-500">failed</p>
                </div>
                <div>
                  <p className="text-lg font-semibold tabular-nums text-slate-900">
                    {sync.counts.staleSkipped}
                  </p>
                  <p className="text-xs text-slate-500">stale skipped</p>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  CDC checkpoints
                </p>
                <div className="mt-1">
                  {sync.checkpoints.length === 0 ? (
                    <span className="text-sm text-slate-500">No channels connected yet.</span>
                  ) : (
                    <ul className="space-y-1 text-xs text-slate-600">
                      {sync.checkpoints.map((checkpoint) => (
                        <li key={checkpoint.channel} className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium text-slate-700">{checkpoint.channel}</span>
                          <span
                            className="truncate text-slate-500"
                            title={checkpoint.replay_id ?? 'no replay id'}
                          >
                            {checkpoint.status}
                            {checkpoint.replay_id
                              ? ` · replay ${shortId(checkpoint.replay_id)}`
                              : ' · no replay id'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
