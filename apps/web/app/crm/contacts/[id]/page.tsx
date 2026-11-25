import Link from 'next/link';
import { getContact } from '@poc/core';
import { Card } from '@/components/stat-card';
import { DetailGrid } from '@/components/detail-grid';
import { PageHeader, buttonSecondary } from '@/components/page-header';
import { SourceBadge, sourceLabel } from '@/components/source-badge';
import { cn, contactName, formatDateTime, shortId } from '@/components/format';
import { loadOrNotFound } from '@/components/load';

export const dynamic = 'force-dynamic';

export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const contact = await loadOrNotFound(() => getContact(id));

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/crm/contacts" className="hover:text-brand-700">
            Contacts
          </Link>
        }
        title={contactName(contact)}
        description={contact.title ?? undefined}
        meta={
          <>
            <SourceBadge source={contact.source} />
            <span className="text-xs text-slate-500" title={contact.id}>
              local id {shortId(contact.id)}
            </span>
          </>
        }
        actions={
          <Link href="/crm/contacts" className={cn(buttonSecondary, 'text-xs')}>
            Back to contacts
          </Link>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Contact details" className="lg:col-span-2">
          <DetailGrid
            items={[
              { label: 'First name', value: contact.first_name },
              { label: 'Last name', value: contact.last_name },
              {
                label: 'Email',
                value: contact.email ? (
                  <a href={`mailto:${contact.email}`} className="text-brand-600 hover:text-brand-700">
                    {contact.email}
                  </a>
                ) : null,
              },
              { label: 'Phone', value: contact.phone },
              { label: 'Title', value: contact.title },
              {
                label: 'Account',
                value: contact.account_id ? (
                  <Link
                    href={`/crm/accounts/${contact.account_id}`}
                    className="text-brand-600 hover:text-brand-700"
                  >
                    {contact.account_name ?? contact.account_id}
                  </Link>
                ) : (
                  <span className="text-slate-400">No account</span>
                ),
              },
              { label: 'Source', value: sourceLabel(contact.source) },
              {
                label: 'Salesforce id',
                value: contact.salesforce_id ? (
                  <code className="text-xs text-slate-700">{contact.salesforce_id}</code>
                ) : (
                  <span className="text-slate-400">Not linked to Salesforce</span>
                ),
                wide: true,
              },
              {
                label: 'Local id',
                value: <code className="text-xs text-slate-700">{contact.id}</code>,
                wide: true,
              },
              { label: 'Created', value: formatDateTime(contact.created_at) },
              { label: 'Updated', value: formatDateTime(contact.updated_at) },
              { label: 'Salesforce updated', value: formatDateTime(contact.salesforce_updated_at) },
              { label: 'Last synced', value: formatDateTime(contact.synced_at) },
            ]}
          />
        </Card>

        <Card title="Links">
          <ul className="space-y-2 text-sm">
            <li>
              {contact.account_id ? (
                <Link
                  href={`/crm/accounts/${contact.account_id}`}
                  className="text-brand-600 hover:text-brand-700"
                >
                  View account {contact.account_name ? `· ${contact.account_name}` : ''}
                </Link>
              ) : (
                <span className="text-slate-500">Not attached to an account.</span>
              )}
            </li>
            {contact.email ? (
              <li>
                <a href={`mailto:${contact.email}`} className="text-brand-600 hover:text-brand-700">
                  Email {contact.email}
                </a>
              </li>
            ) : null}
            <li>
              <Link href="/crm/contacts" className="text-slate-600 hover:text-slate-900">
                All contacts
              </Link>
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}
