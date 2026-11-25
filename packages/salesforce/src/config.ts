/**
 * Environment access for the Salesforce client.
 *
 * Everything is read lazily (never at module load) so tests can tweak env, and
 * so a single process can run the mock and the real path without reloading.
 *
 * Mock vs real (docs/CONTRACTS.md §7):
 *   SF_USE_MOCK=true   → SF_LOGIN_URL / PUBSUB_ENDPOINT point at apps/salesforce-mock
 *   SF_USE_MOCK=false  → real OAuth + api.pubsub.salesforce.com:7443
 */

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

export function sfUseMock(): boolean {
  return flag(process.env.SF_USE_MOCK, true);
}

export function sfApiVersion(): string {
  return process.env.SF_API_VERSION?.trim() || 'v62.0';
}

/** OAuth endpoint base. Mock: http://salesforce-mock:4000. Real: https://login.salesforce.com */
export function sfLoginUrl(): string {
  const configured = process.env.SF_LOGIN_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return sfUseMock() ? 'http://salesforce-mock:4000' : 'https://login.salesforce.com';
}

/** REST base. Falls back to the login URL when no instance URL is configured. */
export function sfConfiguredInstanceUrl(): string | null {
  const value = process.env.SF_INSTANCE_URL?.trim();
  return value ? value.replace(/\/+$/, '') : null;
}

export function pubsubEndpoint(): string {
  const configured = process.env.PUBSUB_ENDPOINT?.trim();
  if (configured) return configured;
  return sfUseMock() ? 'salesforce-mock:50051' : 'api.pubsub.salesforce.com:7443';
}

/** The four CDC topics the worker subscribes to, unless overridden. */
export function defaultTopics(): string[] {
  const explicit = process.env.PUBSUB_TOPICS?.trim();
  if (explicit) {
    return explicit
      .split(',')
      .map((topic) => topic.trim())
      .filter(Boolean);
  }
  const configured = [
    process.env.PUBSUB_TOPIC,
    process.env.PUBSUB_TOPIC_OPPORTUNITY,
    process.env.PUBSUB_TOPIC_CONTACT,
    process.env.PUBSUB_TOPIC_LEAD,
  ].filter((topic): topic is string => Boolean(topic && topic.trim()));

  const defaults = [
    '/data/AccountChangeEvent',
    '/data/ContactChangeEvent',
    '/data/OpportunityChangeEvent',
    '/data/LeadChangeEvent',
  ];
  const merged = [...new Set([...configured, ...defaults])];
  return merged;
}

/** Reconnect backoff (overridable so tests do not wait a full second). */
export function backoffConfig(): { minMs: number; maxMs: number } {
  const minMs = Number(process.env.PUBSUB_MIN_BACKOFF_MS ?? NaN);
  const maxMs = Number(process.env.PUBSUB_MAX_BACKOFF_MS ?? NaN);
  return {
    minMs: Number.isFinite(minMs) && minMs > 0 ? minMs : 1_000,
    maxMs: Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 30_000,
  };
}
