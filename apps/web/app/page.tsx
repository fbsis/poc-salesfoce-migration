import Link from 'next/link';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-brand-600">
          Proof of concept
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight">
          Salesforce Migration &amp; AI-Ready CRM
        </h1>
        <p className="mt-4 text-lg text-slate-600">
          Walkthrough entry points. The CRM and the public lead page are the two
          user-facing surfaces of this POC.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/crm"
          className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition hover:border-brand-500 hover:shadow-md"
        >
          <h2 className="text-lg font-semibold">Internal CRM</h2>
          <p className="mt-2 text-sm text-slate-600">
            Accounts, contacts, opportunities and leads captured from every source.
          </p>
        </Link>
        <Link
          href="/lead"
          className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition hover:border-brand-500 hover:shadow-md"
        >
          <h2 className="text-lg font-semibold">Public lead page</h2>
          <p className="mt-2 text-sm text-slate-600">
            Landing page where a visitor registers and becomes a lead — no Salesforce involved.
          </p>
        </Link>
      </div>
    </main>
  );
}
