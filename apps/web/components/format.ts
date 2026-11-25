/**
 * Presentation helpers shared by the CRM screens.
 *
 * Deliberately dependency-free: `Intl` only (docs/CONTRACTS.md §9 forbids new
 * npm packages, so no `clsx` / `date-fns`).
 */

/** Minimal `clsx`: join truthy class names. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

const integerMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const fractionalMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Money from a `numeric` column (which arrives as a string). Whole amounts are
 * rendered without cents so dense tables stay readable.
 */
export function formatMoney(value: number | string | null | undefined): string {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  const amount = Number.isFinite(parsed) ? parsed : 0;
  return Number.isInteger(amount) ? integerMoney.format(amount) : fractionalMoney.format(amount);
}

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` oracle timestamps → short date. Empty values render an em dash. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '—' : dateFormatter.format(value);
  }
  const raw = String(value);
  // Date-only columns (opportunities.close_date) are calendar days, not instants.
  const date = new Date(DATE_ONLY.test(raw) ? `${raw}T00:00:00.000Z` : raw);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

/** Timestamp with time, for `created_at` / `synced_at` style fields. */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFormatter.format(date);
}

/** Local uuid truncated to 8 chars; always pair with `title={id}`. */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** CDC lag in seconds → `4s`, `3m 12s`, `2h 5m`. */
export function formatLag(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Display name for a contact that may only have one name part. */
export function contactName(contact: {
  first_name: string | null;
  last_name: string | null;
}): string {
  const parts = [contact.first_name, contact.last_name].filter((part): part is string =>
    Boolean(part && part.trim()),
  );
  return parts.length > 0 ? parts.join(' ') : 'Unnamed contact';
}

/** Title-cases the kebab/snake enum values used by leads (`landing_page`). */
export function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** "Showing 1–25 of 40" footer for paged tables. */
export function pagedLabel(page: number, limit: number, total: number): string {
  if (total === 0) return 'No records';
  const start = page * limit + 1;
  const end = Math.min(total, start + limit - 1);
  return `Showing ${start}–${end} of ${total}`;
}
