import Link from 'next/link';
import { getLead } from '@poc/core';
import { Card } from '@/components/stat-card';
import { DetailGrid } from '@/components/detail-grid';
import { PageHeader, buttonSecondary } from '@/components/page-header';
import { SourceBadge, sourceLabel } from '@/components/source-badge';
import { LeadStatusPill } from '@/components/status-pill';
import { LeadStatusForm } from '@/components/lead-status-form';
import { cn, formatDateTime, shortId } from '@/components/format';
import { loadOrNotFound } from '@/components/load';

export const dynamic = 'force-dynamic';

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lead = await loadOrNotFound(() => getLead(id));

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/crm/leads" className="hover:text-brand-700">
            Leads
          </Link>
        }
        title={lead.full_name}
        description={lead.company ?? undefined}
        meta={
          <>
            <SourceBadge source={lead.source} />
            <LeadStatusPill status={lead.status} />
            <span className="text-xs text-slate-500" title={lead.id}>
              local id {shortId(lead.id)}
            </span>
          </>
        }
        actions={
          <Link href="/crm/leads" className={cn(buttonSecondary, 'text-xs')}>
            Back to leads
          </Link>
        }
      />

      <div className="grid gap-5 lg:grid-cols-5">
        <Card title="Lead details" className="lg:col-span-3">
          <DetailGrid
            items={[
              { label: 'Full name', value: lead.full_name },
              {
                label: 'Email',
                value: (
                  <a href={`mailto:${lead.email}`} className="text-brand-600 hover:text-brand-700">
                    {lead.email}
                  </a>
                ),
              },
              { label: 'Phone', value: lead.phone },
              { label: 'Company', value: lead.company },
              { label: 'Property interest', value: lead.property_interest },
              { label: 'Status', value: <LeadStatusPill status={lead.status} /> },
              { label: 'Source', value: sourceLabel(lead.source) },
              {
                label: 'Consent',
                value: lead.consent ? (
                  <span className="text-emerald-700">
                    Given{lead.consent_at ? ` · ${formatDateTime(lead.consent_at)}` : ''}
                  </span>
                ) : (
                  <span className="text-slate-500">Not granted</span>
                ),
              },
              {
                label: 'Message',
                value: lead.message ? (
                  <span className="whitespace-pre-line">{lead.message}</span>
                ) : (
                  <span className="text-slate-400">No message</span>
                ),
                wide: true,
              },
              {
                label: 'Salesforce id',
                value: lead.salesforce_id ? (
                  <code className="text-xs text-slate-700">{lead.salesforce_id}</code>
                ) : (
                  <span className="text-slate-400">Not linked to Salesforce</span>
                ),
                wide: true,
              },
              {
                label: 'Local id',
                value: <code className="text-xs text-slate-700">{lead.id}</code>,
                wide: true,
              },
              { label: 'Created', value: formatDateTime(lead.created_at) },
              { label: 'Updated', value: formatDateTime(lead.updated_at) },
              { label: 'Salesforce updated', value: formatDateTime(lead.salesforce_updated_at) },
              { label: 'Last synced', value: formatDateTime(lead.synced_at) },
            ]}
          />
        </Card>

        <div className="space-y-5 lg:col-span-2">
          <Card title="Update status" description="Writes through updateLeadStatus() and revalidates the lead lists.">
            <LeadStatusForm lead={lead} />
          </Card>

          <Card title="Origin">
            <div className="space-y-2 text-sm text-slate-600">
              <p className="flex items-center gap-2">
                <SourceBadge source={lead.source} />
                <span className="text-xs text-slate-500">{sourceLabel(lead.source)}</span>
              </p>
              <p className="text-xs leading-relaxed text-slate-500">
                {lead.source === 'salesforce'
                  ? 'This lead arrived through the Salesforce sync. Status changes made here are local until a write-back path exists.'
                  : lead.source === 'landing_page'
                    ? 'Captured on the public landing page — no Salesforce involved.'
                    : 'Entered by staff in the CRM.'}
              </p>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
