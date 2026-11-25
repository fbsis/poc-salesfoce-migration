import Link from 'next/link';
import { Card } from '@/components/stat-card';
import { PageHeader, buttonSecondary } from '@/components/page-header';
import { AccountCreateForm } from '@/components/account-create-form';
import { cn } from '@/components/format';

export default function NewAccountPage() {
  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/crm/accounts" className="hover:text-brand-700">
            Accounts
          </Link>
        }
        title="New account"
        description="Create a local account. Name is the only required field."
        actions={
          <Link href="/crm/accounts" className={cn(buttonSecondary, 'text-xs')}>
            Cancel
          </Link>
        }
      />

      <Card className="max-w-3xl">
        <AccountCreateForm />
      </Card>
    </>
  );
}
