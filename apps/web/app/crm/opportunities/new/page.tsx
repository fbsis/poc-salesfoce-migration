import Link from 'next/link';
import { listAccounts } from '@poc/core';
import { Card } from '@/components/stat-card';
import { PageHeader, buttonSecondary } from '@/components/page-header';
import { OpportunityCreateForm } from '@/components/opportunity-form';
import { cn } from '@/components/format';

export const dynamic = 'force-dynamic';

export default async function NewOpportunityPage() {
  const accounts = await listAccounts({ limit: 100 });

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/crm/opportunities" className="hover:text-brand-700">
            Opportunities
          </Link>
        }
        title="New opportunity"
        description="Six Salesforce stages, an optional account, and a USD amount."
        actions={
          <Link href="/crm/opportunities" className={cn(buttonSecondary, 'text-xs')}>
            Cancel
          </Link>
        }
      />

      <Card className="max-w-3xl">
        <OpportunityCreateForm
          accounts={accounts.data.map((account) => ({ id: account.id, name: account.name }))}
        />
      </Card>
    </>
  );
}
