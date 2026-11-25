import Link from 'next/link';
import { listContacts } from '@poc/core';
import { DataTable, TableCell, TableRow } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { FilterBar, FilterText } from '@/components/filter-bar';
import { PageHeader } from '@/components/page-header';
import { PageTotals } from '@/components/page-totals';
import { SourceBadge } from '@/components/source-badge';
import { contactName, formatDateTime, shortId } from '@/components/format';
import { readParam, type SearchParamValue } from '@/components/search-params';

export const dynamic = 'force-dynamic';

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: SearchParamValue }>;
}) {
  const params = await searchParams;
  const search = readParam(params.search);

  const contacts = await listContacts({
    ...(search === '' ? {} : { search }),
    limit: 100,
  });

  return (
    <>
      <PageHeader
        eyebrow="CRM"
        title="Contacts"
        description="People at your accounts — synced from Salesforce or captured locally."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterBar action="/crm/contacts" clearHref="/crm/contacts" submitLabel="Search">
          <FilterText
            name="search"
            label="Search contacts by name or email"
            defaultValue={search}
            placeholder="Search name or email…"
          />
        </FilterBar>
        <PageTotals total={contacts.total} noun="contact" />
      </div>

      {contacts.data.length === 0 ? (
        <EmptyState
          title={search ? `No contacts match “${search}”` : 'No contacts yet'}
          description={
            search
              ? 'Try a different name or email.'
              : 'Contacts arrive with the Salesforce bulk extract; they are created per account.'
          }
          action={
            search ? (
              <Link href="/crm/contacts" className="text-sm font-medium text-brand-600 hover:text-brand-700">
                Clear search
              </Link>
            ) : (
              <Link href="/crm/accounts" className="text-sm font-medium text-brand-600 hover:text-brand-700">
                Browse accounts
              </Link>
            )
          }
        />
      ) : (
        <DataTable
          caption="Contacts, with email, account, phone and source"
          columns={[
            { label: 'Contact' },
            { label: 'Email' },
            { label: 'Account' },
            { label: 'Phone' },
            { label: 'Source' },
            { label: 'Updated', align: 'right' },
          ]}
          footer={<span>{contacts.total} contacts</span>}
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
                <p className="text-xs text-slate-400" title={contact.id}>
                  {shortId(contact.id)}
                </p>
              </TableCell>
              <TableCell>
                {contact.email ? (
                  <a href={`mailto:${contact.email}`} className="text-slate-700 hover:text-brand-600">
                    {contact.email}
                  </a>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </TableCell>
              <TableCell>
                {contact.account_id ? (
                  <Link
                    href={`/crm/accounts/${contact.account_id}`}
                    className="text-slate-700 hover:text-brand-600"
                  >
                    {contact.account_name ?? shortId(contact.account_id)}
                  </Link>
                ) : (
                  <span className="text-slate-400">No account</span>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">{contact.phone ?? <span className="text-slate-400">—</span>}</TableCell>
              <TableCell>
                <SourceBadge source={contact.source} />
              </TableCell>
              <TableCell align="right" className="whitespace-nowrap text-xs text-slate-500">
                {formatDateTime(contact.updated_at)}
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </>
  );
}
