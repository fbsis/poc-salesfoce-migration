/**
 * `searchParams` values are `string | string[] | undefined` in the App Router.
 * The CRM filters are single-valued, so take the first entry.
 */
export type SearchParamValue = string | string[] | undefined;

export function readParam(value: SearchParamValue): string {
  if (Array.isArray(value)) return (value[0] ?? '').trim();
  return (value ?? '').trim();
}

/** Drops empty values so `/crm/opportunities?stage=&search=` stays clean. */
export function buildQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }
  const serialised = query.toString();
  return serialised === '' ? '' : `?${serialised}`;
}
