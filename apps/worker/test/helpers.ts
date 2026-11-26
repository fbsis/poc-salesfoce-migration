/**
 * Test helpers: talk to the live mock (REST admin + gRPC) and the real Postgres.
 * Nothing here starts a service — the suite assumes `salesforce-mock` and
 * `postgres` are up (docker compose) and that the schema is migrated.
 */
import { randomBytes } from 'node:crypto';

export const MOCK_URL = (process.env.SF_LOGIN_URL ?? 'http://salesforce-mock:4000').replace(/\/+$/, '');
export const OPPORTUNITY_TOPIC = '/data/OpportunityChangeEvent';
export const ACCOUNT_TOPIC = '/data/AccountChangeEvent';

export interface MockDataset {
  accounts: Array<Record<string, unknown>>;
  contacts: Array<Record<string, unknown>>;
  opportunities: Array<Record<string, unknown>>;
  leads: Array<Record<string, unknown>>;
}

export interface MockState {
  dataset: MockDataset;
  counts: { accounts: number; contacts: number; opportunities: number; leads: number };
  latestReplayId: number;
  latestCommitNumber: number;
  events: Array<{ replayId: number; topic: string; changeType: string }>;
}

export interface MockHealth {
  status: string;
  dataset: { accounts: number; contacts: number; opportunities: number; leads: number };
  subscribers: number;
  latestReplayId: number;
  latestCommitNumber: number;
  queryJobPageSize: number;
}

export interface EmitResult {
  ok: boolean;
  object: string;
  changeType: string;
  topic: string;
  replayId: number;
  commitNumber: number;
  commitTimestamp: number;
  changedFields: string[];
  nulledFields: string[];
  delivered: number;
  queued: boolean;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 6-char random alphanumeric marker for ids/channels. */
export function uniqueSuffix(): string {
  return randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
}

async function mockJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${MOCK_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`mock ${path} → ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export async function mockHealth(): Promise<MockHealth> {
  return mockJson<MockHealth>('/mock/health');
}

export async function mockState(): Promise<MockState> {
  return mockJson<MockState>('/mock/state');
}

export interface SeedOptions {
  /**
   * `replace` (default) makes the supplied rows the whole dataset — a suite that
   * asserts on counts wants this; `merge` upserts into the current dataset.
   */
  mode?: 'replace' | 'merge';
}

/**
 * `POST /mock/seed` — replaces the mock dataset by default (docs/CONTRACTS.md
 * §6). A suite must seed exactly the dataset it asserts on: the mock is shared
 * with every other suite and with the running demo worker, so “whatever is in
 * there” is never a fixture.
 */
export async function seedMock(
  dataset: Partial<MockDataset>,
  options: SeedOptions = {},
): Promise<{ counts: MockState['counts']; mode: string }> {
  return mockJson('/mock/seed', {
    method: 'POST',
    body: JSON.stringify({ ...dataset, mode: options.mode ?? 'replace' }),
  });
}

/** `POST /mock/reset` — clears dataset + event log. */
export async function resetMock(): Promise<{ counts: MockState['counts']; events: number }> {
  return mockJson('/mock/reset', { method: 'POST', body: '{}' });
}

/** POST /mock/emit — publishes a real Avro CDC event over the real gRPC stream. */
export async function emitChange(input: {
  object: string;
  changeType: 'CREATE' | 'UPDATE' | 'DELETE' | 'UNDELETE';
  record: Record<string, unknown>;
  changedFields?: string[];
}): Promise<EmitResult> {
  return mockJson<EmitResult>('/mock/emit', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** POST /mock/disconnect — forcibly ends matching gRPC streams. */
export async function disconnectStreams(topic?: string): Promise<{ disconnected: number }> {
  return mockJson<{ disconnected: number }>('/mock/disconnect', {
    method: 'POST',
    body: JSON.stringify(topic ? { topic } : {}),
  });
}

/** POST /mock/config — test hook for the mock's behaviour (query-job page size). */
export async function setMockQueryPageJobSize(size: number): Promise<{ queryJobPageSize: number }> {
  return mockJson<{ ok: boolean; queryJobPageSize: number }>('/mock/config', {
    method: 'POST',
    body: JSON.stringify({ queryJobPageSize: size }),
  });
}

/** Poll `fn` until it returns a non-nullish value, or fail after `timeoutMs`. */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let last: T | null | undefined = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last !== null && last !== undefined) return last;
    await sleep(intervalMs);
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms${options.label ? ` — ${options.label}` : ''}`,
  );
}

/** 18-char Salesforce-shaped id with a test prefix, e.g. `006VITEST1A2B3CAAA`. */
export function testSalesforceId(prefix: string, suffix = uniqueSuffix()): string {
  return `${prefix}${suffix}`.toUpperCase().padEnd(18, 'A').slice(0, 18);
}
