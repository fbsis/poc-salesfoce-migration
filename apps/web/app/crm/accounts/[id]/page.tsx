import Link from 'next/link';
import { getAccount, listContacts, listOpportunities } from '@poc/core';
import { Card } from '@/components/stat-card';
import { DataTable, TableCell, TableRow } from '@/components/data-table';
import { DetailGrid } from '@/components/detail-grid';
import { EmptyState } from '@/components/empty-state';
import { PageHeader, buttonSecondary } from '@/components/page-header';
import { SourceBadge, sourceLabel } from '@/components/source-badge';
import { StagePill } from '@/components/status-pill';
import { contactName, cn, formatDate, formatDateTime, formatMoney, shortId } from '@/components/format';
import { loadOrNotFound } from '@/components/load';

export const dynamic = 'force-dynamic';

export default async function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await loadOrNotFound(() => getAccount(id));

  const [contacts, opportunities] = await Promise.all([
    listContacts({ account_id: account.id, limit: 50 }),
    listOpportunities({ account_id: account.id, limit: 50 }),
  ]);

  const pipelineValue = opportunities.data.reduce((sum, opportunity) => sum + Number(opportunity.amount), 0);

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/crm/accounts" className="hover:text-brand-700">
            Accounts
          </Link>
        }
        title={account.name}
        description={
          account.industry ? `${account.industry}${account.billing_country ? ` · ${account.billing_country}` : ''}` : undefined
        }
        meta={
          <>
            <SourceBadge source={account.source} />
            <span className="text-xs text-slate-500" title={account.id}>
              local id {shortId(account.id)}
            </span>
          </>
        }
        actions={
          <Link href="/crm/accounts" className={cn(buttonSecondary, 'text-xs')}>
            Back to accounts
          </Link>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Account details" className="lg:col-span-2">
          <DetailGrid
            items={[
              { label: 'Name', value: account.name },
              { label: 'Industry', value: account.industry },
              { label: 'Owner', value: account.owner_name },
              { label: 'Billing country', value: account.billing_country },
              {
                label: 'Website',
                value: account.website ? (
                  <a
                    href={account.website}
                    className="text-brand-600 hover:text-brand-700"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {account.website}
                  </a>
                ) : null,
              },
              { label: 'Source', value: sourceLabel(account.source) },
              {
                label: 'Salesforce id',
                value: account.salesforce_id ? (
                  <code className="text-xs text-slate-700">{account.salesforce_id}</code>
                ) : (
                  <span className="text-slate-400">Not linked to Salesforce</span>
                ),
                wide: true,
              },
              {
                label: 'Local id',
                value: <code className="text-xs text-slate-700">{account.id}</code>,
                wide: true,
              },
              { label: 'Created', value: formatDateTime(account.created_at) },
              { label: 'Updated', value: formatDateTime(account.updated_at) },
              { label: 'Salesforce updated', value: formatDateTime(account.salesforce_updated_at) },
              { label: 'Last synced', value: formatDateTime(account.synced_at) },
            ]}
          />
        </Card>

        <Card title="Summary">
          <div className="space-y-3 text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-slate-500">Contacts</span>
              <span className="text-lg font-semibold tabular-nums text-slate-900">{contacts.total}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-slate-500">Opportunities</span>
              <span className="text-lg font-semibold tabular-nums text-slate-900">
                {opportunities.total}
              </span>
            </div>
            <div className="flex items-baseline justify-between border-t border-slate-200 pt-3">
              <span className="text-slate-500">Open pipeline</span>
              <span className="text-lg font-semibold tabular-nums text-slate-900">
                {formatMoney(pipelineValue)}
              </span>
            </div>
          </div>
        </Card>
      </div>

      <div className="mt-5 space-y-5">
        <Card
          title="Contacts"
          description="People at this account."
          bodyClassName="px-0 py-0"
        >
          {contacts.data.length === 0 ? (
            <EmptyState compact title="No contacts at this account yet" />
          ) : (
            <DataTable
              plain
              caption={`Contacts at ${account.name}`}
              columns={[
                { label: 'Name' },
                { label: 'Email' },
                { label: 'Title' },
                { label: 'Source' },
              ]}
            >
              {contacts.data.map((contact) => (
                <TableRow key={contact.id}>
                  <TableCell>
                    <Link
                      href={`/crm/contacts/${contact.id}`}
                      className="font-medium text-slate-900 hover:text-brand-600"
                    >
                      {contactName(contact)}
                    </Link>
                  </TableCell>
                  <TableCell>{contact.email ?? <span className="text-slate-400">—</span>}</TableCell>
                  <TableCell>{contact.title ?? <span className="text-slate-400">—</span>}</TableCell>
                  <TableCell>
                    <SourceBadge source={contact.source} />
                  </TableCell>
                </TableRow>
              ))}
            </DataTable>
          )}
        </Card>

        <Card
          title="Opportunities"
          description="Deals attached to this account."
          bodyClassName="px-0 py-0"
        >
          {opportunities.data.length === 0 ? (
            <EmptyState compact title="No opportunities for this account yet" />
          ) : (
            <DataTable
              plain
              caption={`Opportunities for ${account.name}`}
              columns={[
                { label: 'Opportunity' },
                { label: 'Stage' },
                { label: 'Amount', align: 'right' },
                { label: 'Close date', align: 'right' },
              ]}
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
                    <StagePill stage={opportunity.stage} />
                  </TableCell>
                  <TableCell align="right">{formatMoney(opportunity.amount)}</TableCell>
                  <TableCell align="right" className="whitespace-nowrap text-xs text-slate-500">
                    {formatDate(opportunity.close_date)}
                  </TableCell>
                </TableRow>
              ))}
            </DataTable>
          )}
        </Card>
      </div>
    </>
  );
}
