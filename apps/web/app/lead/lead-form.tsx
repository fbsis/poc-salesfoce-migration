'use client';

/**
 * Public lead form (docs/CONTRACTS.md §5/§9).
 *
 * Client component: local state, JSON POST to `/api/leads`, inline field errors
 * from `error.details`, an aria-live feedback region, and a success card that
 * replaces the form. No CRM data beyond the created lead's id/status is used.
 */
import { useRef, useState } from 'react';

type Status = 'idle' | 'submitting' | 'success';

interface LeadReference {
  id: string;
  status: string;
  source: string;
  created_at: string;
}

interface SuccessState {
  lead: LeadReference;
  duplicate: boolean;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

const FIELD_IDS = {
  full_name: 'lead-full_name',
  email: 'lead-email',
  phone: 'lead-phone',
  property_interest: 'lead-property_interest',
  message: 'lead-message',
  consent: 'lead-consent',
  company_website: 'lead-company_website',
} as const;

type FieldName = keyof typeof FIELD_IDS;
type FieldErrors = Partial<Record<FieldName, string>>;

const INTERESTS = ['Apartment', 'House', 'Condo', 'Commercial', 'Land', 'Not sure'] as const;

const INITIAL_VALUES = {
  full_name: '',
  email: '',
  phone: '',
  property_interest: '',
  message: '',
  company_website: '',
};

const inputClass = (invalid: boolean) =>
  [
    'w-full rounded-lg border bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition',
    'placeholder:text-slate-400 focus:ring-2 focus:ring-brand-500/30',
    invalid
      ? 'border-red-400 focus:border-red-500 focus:ring-red-500/20'
      : 'border-slate-300 focus:border-brand-500',
    'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500',
  ].join(' ');

const labelClass = 'block text-sm font-medium text-slate-800';

function errorId(field: FieldName): string {
  return `${FIELD_IDS[field]}-error`;
}

function FieldError({ field, errors }: { field: FieldName; errors: FieldErrors }) {
  const message = errors[field];
  if (!message) return null;
  return (
    <p id={errorId(field)} className="mt-1.5 text-sm text-red-600">
      {message}
    </p>
  );
}

function firstNameOf(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : 'there';
}

export default function LeadForm() {
  const [values, setValues] = useState({ ...INITIAL_VALUES, consent: false });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const submitting = status === 'submitting';

  function setField(field: keyof typeof INITIAL_VALUES, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function focusFirstInvalid(fields: string[]) {
    const target = fields.find((field): field is FieldName => field in FIELD_IDS);
    if (!target) return;
    requestAnimationFrame(() => {
      const element = document.getElementById(FIELD_IDS[target]);
      if (element instanceof HTMLElement) element.focus();
    });
  }

  function resetAll() {
    setValues({ ...INITIAL_VALUES, consent: false });
    setErrors({});
    setBanner(null);
    setSuccess(null);
    setStatus('idle');
    requestAnimationFrame(() => formRef.current?.querySelector('input')?.focus());
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setStatus('submitting');
    setErrors({});
    setBanner(null);

    try {
      const response = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          full_name: values.full_name,
          email: values.email,
          phone: values.phone,
          property_interest: values.property_interest,
          message: values.message,
          consent: values.consent,
          company_website: values.company_website,
        }),
      });

      const body = (await response.json().catch(() => null)) as
        | (ApiErrorBody & { data?: LeadReference; duplicate?: boolean })
        | null;

      if (response.ok && body?.data) {
        setSuccess({ lead: body.data, duplicate: body.duplicate === true });
        setStatus('success');
        return;
      }

      const details = body?.error?.details;
      if (response.status === 400 && details && typeof details === 'object' && !Array.isArray(details)) {
        const fieldErrors: FieldErrors = {};
        for (const [key, message] of Object.entries(details as Record<string, unknown>)) {
          if (typeof message === 'string' && key in FIELD_IDS) {
            fieldErrors[key as FieldName] = message;
          }
        }
        setErrors(fieldErrors);
        const invalidFields = Object.keys(fieldErrors);
        setBanner(
          invalidFields.length > 0
            ? 'Please check the highlighted fields and try again.'
            : (body?.error?.message ?? 'Please check your details and try again.'),
        );
        if (invalidFields.length > 0) focusFirstInvalid(invalidFields);
      } else if (response.status === 429) {
        setBanner('Too many submissions from this connection. Please try again in a few minutes.');
      } else {
        setBanner('Something went wrong on our side. Please try again in a moment.');
      }
      setStatus('idle');
    } catch {
      setBanner('We could not reach the server. Please check your connection and try again.');
      setStatus('idle');
    }
  }

  if (status === 'success' && success) {
    const reference = success.lead.id ? success.lead.id.slice(0, 8).toUpperCase() : '—';
    return (
      <div
        className="rounded-2xl border border-brand-100 bg-white p-8 shadow-xl shadow-brand-500/5"
        aria-live="polite"
      >
        <div
          className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" stroke="currentColor" strokeWidth="2">
            <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="mt-5 text-2xl font-semibold tracking-tight text-slate-900">
          Thanks, {firstNameOf(values.full_name)} — we&apos;ll be in touch
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          {success.duplicate
            ? 'We already have your details on file, so there is nothing else to do. One of our local advisors will reach out shortly.'
            : 'A local advisor will reach out shortly with a shortlist that matches what you told us. No pressure, no spam — just homes worth your time.'}
        </p>

        <dl className="mt-6 grid grid-cols-2 gap-4 rounded-xl bg-slate-50 p-4 text-sm">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Reference</dt>
            <dd className="mt-1 font-mono text-slate-900">{reference}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Status</dt>
            <dd className="mt-1 capitalize text-slate-900">{success.lead.status}</dd>
          </div>
        </dl>

        <button
          type="button"
          onClick={resetAll}
          className="mt-6 inline-flex w-full items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:border-brand-500 hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 sm:w-auto"
        >
          Submit another
        </button>
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      noValidate
      className="relative rounded-2xl border border-brand-100 bg-white p-6 shadow-xl shadow-brand-500/5 sm:p-8"
      aria-labelledby="lead-form-heading"
    >
      <h2 id="lead-form-heading" className="text-xl font-semibold tracking-tight text-slate-900">
        Tell us what you&apos;re looking for
      </h2>
      <p className="mt-1.5 text-sm text-slate-600">Takes about a minute. No obligation to buy.</p>

      {/* Feedback region: errors announced politely, never steals focus. */}
      <div aria-live="polite" className="min-h-0">
        {banner ? (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700"
          >
            {banner}
          </p>
        ) : null}
      </div>

      <div className="mt-5 space-y-4">
        <div>
          <label htmlFor={FIELD_IDS.full_name} className={labelClass}>
            Full name <span className="text-red-500">*</span>
          </label>
          <input
            id={FIELD_IDS.full_name}
            name="full_name"
            type="text"
            autoComplete="name"
            required
            maxLength={120}
            value={values.full_name}
            onChange={(event) => setField('full_name', event.target.value)}
            disabled={submitting}
            aria-invalid={errors.full_name ? true : undefined}
            aria-describedby={errors.full_name ? errorId('full_name') : undefined}
            className={`mt-1.5 ${inputClass(Boolean(errors.full_name))}`}
            placeholder="Maria Silva"
          />
          <FieldError field="full_name" errors={errors} />
        </div>

        <div>
          <label htmlFor={FIELD_IDS.email} className={labelClass}>
            Email <span className="text-red-500">*</span>
          </label>
          <input
            id={FIELD_IDS.email}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            maxLength={254}
            value={values.email}
            onChange={(event) => setField('email', event.target.value)}
            disabled={submitting}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? errorId('email') : undefined}
            className={`mt-1.5 ${inputClass(Boolean(errors.email))}`}
            placeholder="you@example.com"
          />
          <FieldError field="email" errors={errors} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={FIELD_IDS.phone} className={labelClass}>
              Phone <span className="text-slate-400">(optional)</span>
            </label>
            <input
              id={FIELD_IDS.phone}
              name="phone"
              type="tel"
              autoComplete="tel"
              maxLength={40}
              value={values.phone}
              onChange={(event) => setField('phone', event.target.value)}
              disabled={submitting}
              aria-invalid={errors.phone ? true : undefined}
              aria-describedby={errors.phone ? errorId('phone') : undefined}
              className={`mt-1.5 ${inputClass(Boolean(errors.phone))}`}
              placeholder="+55 11 99999-0000"
            />
            <FieldError field="phone" errors={errors} />
          </div>

          <div>
            <label htmlFor={FIELD_IDS.property_interest} className={labelClass}>
              Property interest <span className="text-slate-400">(optional)</span>
            </label>
            <select
              id={FIELD_IDS.property_interest}
              name="property_interest"
              value={values.property_interest}
              onChange={(event) => setField('property_interest', event.target.value)}
              disabled={submitting}
              aria-invalid={errors.property_interest ? true : undefined}
              aria-describedby={errors.property_interest ? errorId('property_interest') : undefined}
              className={`mt-1.5 ${inputClass(Boolean(errors.property_interest))}`}
            >
              <option value="">Select a type</option>
              {INTERESTS.map((interest) => (
                <option key={interest} value={interest}>
                  {interest}
                </option>
              ))}
            </select>
            <FieldError field="property_interest" errors={errors} />
          </div>
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={FIELD_IDS.message} className={labelClass}>
              Message <span className="text-slate-400">(optional)</span>
            </label>
            <span className="text-xs tabular-nums text-slate-400">{values.message.length}/2000</span>
          </div>
          <textarea
            id={FIELD_IDS.message}
            name="message"
            rows={4}
            maxLength={2000}
            value={values.message}
            onChange={(event) => setField('message', event.target.value)}
            disabled={submitting}
            aria-invalid={errors.message ? true : undefined}
            aria-describedby={errors.message ? errorId('message') : undefined}
            className={`mt-1.5 resize-y ${inputClass(Boolean(errors.message))}`}
            placeholder="A 3-bedroom near the park, move-in by March…"
          />
          <FieldError field="message" errors={errors} />
        </div>

        <div className="rounded-lg bg-slate-50 p-3.5">
          <div className="flex items-start gap-3">
            <input
              id={FIELD_IDS.consent}
              name="consent"
              type="checkbox"
              checked={values.consent}
              onChange={(event) => setValues((current) => ({ ...current, consent: event.target.checked }))}
              disabled={submitting}
              aria-invalid={errors.consent ? true : undefined}
              aria-describedby={errors.consent ? errorId('consent') : undefined}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-500/40"
            />
            <label htmlFor={FIELD_IDS.consent} className="text-sm leading-relaxed text-slate-700">
              I agree to be contacted about properties and accept the privacy notice.{' '}
              <span className="text-red-500">*</span>
            </label>
          </div>
          <FieldError field="consent" errors={errors} />
        </div>

        {/* Honeypot: hidden from people, irresistible to bots. */}
        <div aria-hidden="true" className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
          <label htmlFor={FIELD_IDS.company_website}>Company website</label>
          <input
            id={FIELD_IDS.company_website}
            name="company_website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={values.company_website}
            onChange={(event) => setField('company_website', event.target.value)}
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-brand-500/70"
        >
          {submitting ? (
            <>
              <span
                className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                aria-hidden="true"
              />
              Sending…
            </>
          ) : (
            'Request my shortlist'
          )}
        </button>

        <p className="text-center text-xs leading-relaxed text-slate-500">
          We use your details only to answer your enquiry. Fields marked * are required.
        </p>
      </div>
    </form>
  );
}
