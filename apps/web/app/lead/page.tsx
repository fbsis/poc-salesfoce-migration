import type { Metadata } from 'next';
import LeadForm from './lead-form';

/**
 * Public landing page for lead capture (docs/CONTRACTS.md §5, §9).
 * Server component; the only interactive part is the client form.
 * No images: the layout is pure CSS (brand gradient, cards, whitespace).
 */
export const metadata: Metadata = {
  title: 'Find Your Next Home — Harbor & Vine',
  description:
    'Tell us what you are looking for and a local advisor will send a shortlist of homes that fit. No obligation, no spam.',
};

const BENEFITS = [
  {
    title: 'Homes matched to you',
    body: 'We filter listings by the things that actually matter — neighbourhood, commute, light, storage — not by what is easiest to sell.',
  },
  {
    title: 'One advisor, start to finish',
    body: 'The person who reads your message is the person who shows you the homes and negotiates the paperwork.',
  },
  {
    title: 'No pressure, ever',
    body: 'Ask for a shortlist and take your time. We will not call you daily or pass your details to a call centre.',
  },
];

const CHECKS = ['Viewings within 48 hours', 'Local advisors, not a call centre', 'Free, no obligation'];

export default function LeadPage() {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-slate-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white"
              aria-hidden="true"
            >
              HV
            </span>
            <span className="text-base font-semibold tracking-tight text-slate-900">Harbor &amp; Vine</span>
          </div>
          <a
            href="#lead-form"
            className="rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-800 transition hover:border-brand-500 hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            Get started
          </a>
        </div>
      </header>

      <main>
        {/* Hero: soft brand gradient, copy left, form right. */}
        <section className="relative overflow-hidden bg-gradient-to-b from-brand-50 via-brand-50/40 to-white">
          <div
            className="pointer-events-none absolute -right-24 -top-32 h-80 w-80 rounded-full bg-brand-100/70 blur-3xl"
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute -bottom-40 -left-24 h-80 w-80 rounded-full bg-emerald-100/50 blur-3xl"
            aria-hidden="true"
          />

          <div className="relative mx-auto grid max-w-6xl gap-12 px-6 py-16 lg:grid-cols-[1.05fr_minmax(0,420px)] lg:items-start lg:py-24">
            <div className="max-w-xl">
              <p className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-white/70 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-brand-700">
                Residential &amp; commercial
              </p>
              <h1 className="mt-5 text-4xl font-bold leading-tight tracking-tight text-slate-900 sm:text-5xl">
                Find Your <span className="text-brand-600">Next Home</span>
              </h1>
              <p className="mt-5 text-lg leading-relaxed text-slate-600">
                Register once and tell us what you are looking for. A local advisor reads your message,
                puts together a shortlist of homes that actually fit, and books the viewings around your
                week — no account to create, no app to install.
              </p>

              <ul className="mt-7 space-y-2.5">
                {CHECKS.map((check) => (
                  <li key={check} className="flex items-center gap-2.5 text-sm font-medium text-slate-700">
                    <span
                      className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
                      aria-hidden="true"
                    >
                      <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="3">
                        <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    {check}
                  </li>
                ))}
              </ul>

              <dl className="mt-10 grid max-w-md grid-cols-3 gap-4 border-t border-brand-100 pt-6">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Advisors</dt>
                  <dd className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">14</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Viewings / mo</dt>
                  <dd className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">320</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Avg. reply</dt>
                  <dd className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">4h</dd>
                </div>
              </dl>
            </div>

            <div id="lead-form" className="scroll-mt-24">
              <LeadForm />
            </div>
          </div>
        </section>

        {/* Why register */}
        <section className="mx-auto max-w-6xl px-6 py-16 lg:py-20">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
              Why register with Harbor &amp; Vine
            </h2>
            <p className="mt-3 text-base leading-relaxed text-slate-600">
              A shortlist from a real person beats an endless feed of listings that do not fit. That is the
              whole idea.
            </p>
          </div>

          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {BENEFITS.map((benefit) => (
              <article
                key={benefit.title}
                className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition hover:border-brand-200 hover:shadow-md"
              >
                <h3 className="text-base font-semibold text-slate-900">{benefit.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{benefit.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* Privacy note */}
        <section className="border-t border-slate-200 bg-slate-50">
          <div className="mx-auto max-w-6xl px-6 py-12">
            <div className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8">
              <h2 className="text-lg font-semibold text-slate-900">Your privacy</h2>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">
                We store the details you submit — name, email, and any phone number, property interest or
                message you choose to add — so an advisor can answer your enquiry. We do not sell or share
                them with third-party advertisers, and we only contact you about properties. You can ask us
                to delete your details at any time by replying to any email from us.
              </p>
              <p className="mt-3 text-xs text-slate-500">
                This is a proof-of-concept landing page: submissions are stored in the demo CRM database.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Harbor &amp; Vine Realty — demo data.</p>
          <p>
            Looking for the internal view?{' '}
            <a href="/crm" className="font-medium text-brand-700 underline-offset-2 hover:underline">
              Open the CRM
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
