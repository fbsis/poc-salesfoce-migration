import Link from 'next/link';
import { getOpportunity, listAccounts } from '@poc/core';
import { Card } from '@/components/stat-card';
import { DetailGrid } from '@/components/detail-grid';
import { PageHeader, buttonSecondary } from '@/components/page-header';
import { SourceBadge, sourceLabel } from '@/components/source-badge';
import { StagePill } from '@/components/status-pill';
import { OpportunityEditForm } from '@/components/opportunity-form';
import { cn, formatDate, formatDateTime, formatMoney, shortId } from '@/components/format';
import { loadOrNotFound } from '@/components/load';

export const dynamic = 'force-dynamic';

export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const opportunity = await loadOrNotFound(() => getOpportunity(id));
  const accounts = await listAccounts({ limit: 100 });

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/crm/opportunities" className="hover:text-brand-700">
            Opportunities
          </Link>
        }
        title={opportunity.name}
        description={`${formatMoney(opportunity.amount)} · ${opportunity.stage}`}
        meta={
          <>
            <StagePill stage={opportunity.stage} />
            <SourceBadge source={opportunity.source} />
            <span className="text-xs text-slate-500" title={opportunity.id}>
              local id {shortId(opportunity.id)}
            </span>
          </>
        }
        actions={
          <Link href="/crm/opportunities" className={cn(buttonSecondary, 'text-xs')}>
            Back to opportunities
          </Link>
        }
      />

      <div className="grid gap-5 lg:grid-cols-5">
        <Card title="Opportunity details" className="lg:col-span-3">
          <DetailGrid
            items={[
              { label: 'Name', value: opportunity.name },
              { label: 'Stage', value: <StagePill stage={opportunity.stage} /> },
              { label: 'Amount', value: formatMoney(opportunity.amount) },
              { label: 'Close date', value: formatDate(opportunity.close_date) },
              { label: 'Owner', value: opportunity.owner_name },
              {
                label: 'Probability',
                value:
                  opportunity.probability === null ? null : `${opportunity.probability}%`,
              },
              {
                label: 'Account',
                value: opportunity.account_id ? (
                  <Link
                    href={`/crm/accounts/${opportunity.account_id}`}
                    className="text-brand-600 hover:text-brand-700"
                  >
                    {opportunity.account_name ?? opportunity.account_id}
                  </Link>
                ) : (
                  <span className="text-slate-400">No account</span>
                ),
              },
              { label: 'Source', value: sourceLabel(opportunity.source) },
              {
                label: 'Salesforce id',
                value: opportunity.salesforce_id ? (
                  <code className="text-xs text-slate-700">{opportunity.salesforce_id}</code>
                ) : (
                  <span className="text-slate-400">Not linked to Salesforce</span>
                ),
                wide: true,
              },
              {
                label: 'Local id',
                value: <code className="text-xs text-slate-700">{opportunity.id}</code>,
                wide: true,
              },
              { label: 'Created', value: formatDateTime(opportunity.created_at) },
              { label: 'Updated', value: formatDateTime(opportunity.updated_at) },
              { label: 'Salesforce updated', value: formatDateTime(opportunity.salesforce_updated_at) },
              { label: 'Last synced', value: formatDateTime(opportunity.synced_at) },
            ]}
          />
        </Card>

        <Card
          title="Edit opportunity"
          description="Stage, amount, close date and owner are editable here."
          className="lg:col-span-2"
        >
          <OpportunityEditForm
            opportunity={opportunity}
            accounts={accounts.data.map((account) => ({ id: account.id, name: account.name }))}
          />
          <p className="mt-3 text-xs text-slate-400">
            Saves go through <code className="text-slate-600">updateOpportunity()</code> and
            revalidate the dashboard, the list and this page.
          </p>
        </Card>
      </div>
    </>
  );
}
