import Link from 'next/link';
import { LEAD_STATUSES, listLeads, type LeadStatus } from '@poc/core';
import { DataTable, TableCell, TableRow } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { FilterBar, FilterSelect, FilterText } from '@/components/filter-bar';
import { PageHeader } from '@/components/page-header';
import { PageTotals } from '@/components/page-totals';
import { SourceBadge } from '@/components/source-badge';
import { LeadStatusPill } from '@/components/status-pill';
import { LEAD_STATUS_OPTIONS } from '@/components/enums';
import { formatDateTime, shortId } from '@/components/format';
import { readParam, type SearchParamValue } from '@/components/search-params';

export const dynamic = 'force-dynamic';

function parseStatus(raw: string): LeadStatus | undefined {
  return (LEAD_STATUSES as readonly string[]).includes(raw) ? (raw as LeadStatus) : undefined;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: SearchParamValue; status?: SearchParamValue }>;
}) {
  const params = await searchParams;
  const search = readParam(params.search);
  const status = parseStatus(readParam(params.status));

  const leads = await listLeads({
    ...(search === '' ? {} : { search }),
    ...(status ? { status } : {}),
    limit: 100,
  });

  const filtered = search !== '' || status !== undefined;

  return (
    <>
      <PageHeader
        eyebrow="CRM"
        title="Leads"
        description="Website sign-ups, Salesforce leads and anything entered locally — badged by origin, filtered by status."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterBar action="/crm/leads" clearHref="/crm/leads" submitLabel="Filter">
          <FilterText
            name="search"
            label="Search leads by name, email, company or interest"
            defaultValue={search}
            placeholder="Search name, email, company…"
          />
          <FilterSelect
            name="status"
            label="Filter by status"
            value={status}
            options={LEAD_STATUS_OPTIONS}
            allLabel="All statuses"
          />
        </FilterBar>
        <PageTotals total={leads.total} noun={status ? `${status} lead` : 'lead'} />
      </div>

      {leads.data.length === 0 ? (
        <EmptyState
          title={filtered ? 'No leads match these filters' : 'No leads yet'}
          description={
            filtered
              ? 'Try a different search term or status.'
              : 'The public lead page writes here the moment a visitor signs up, and the Salesforce bulk extract adds the rest.'
          }
          action={
            filtered ? (
              <Link href="/crm/leads" className="text-sm font-medium text-brand-600 hover:text-brand-700">
                Clear filters
              </Link>
            ) : (
              <Link href="/lead" className="text-sm font-medium text-brand-600 hover:text-brand-700">
                Open the public lead page
              </Link>
            )
          }
        />
      ) : (
        <DataTable
          caption="Leads with email, source, status and creation time"
          columns={[
            { label: 'Lead' },
            { label: 'Email' },
            { label: 'Source' },
            { label: 'Status' },
            { label: 'Created', align: 'right' },
          ]}
          footer={<span>{leads.total} leads in this view</span>}
        >
          {leads.data.map((lead) => (
            <TableRow key={lead.id}>
              <TableCell>
                <Link
                  href={`/crm/leads/${lead.id}`}
                  className="font-medium text-slate-900 hover:text-brand-600"
                >
                  {lead.full_name}
                </Link>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span title={lead.id}>{shortId(lead.id)}</span>
                  {lead.company ? <span className="text-slate-500">· {lead.company}</span> : null}
                </div>
              </TableCell>
              <TableCell>
                <a href={`mailto:${lead.email}`} className="text-slate-700 hover:text-brand-600">
                  {lead.email}
                </a>
                {lead.property_interest ? (
                  <p className="text-xs text-slate-500">{lead.property_interest}</p>
                ) : null}
              </TableCell>
              <TableCell>
                <SourceBadge source={lead.source} />
              </TableCell>
              <TableCell>
                <LeadStatusPill status={lead.status} />
              </TableCell>
              <TableCell align="right" className="whitespace-nowrap text-xs text-slate-500">
                <span title={lead.created_at}>{formatDateTime(lead.created_at)}</span>
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </>
  );
}
