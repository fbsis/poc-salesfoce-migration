/**
 * Shared helpers for the end-to-end suite (`apps/web/test/e2e`) — the five
 * capabilities in docs/POC-CHECKLIST.md "Definition of Success".
 *
 * Everything here talks to the *running stack* over HTTP, exactly like a
 * customer/agent would. Only `cleanupE2EData()` touches Postgres directly
 * (through `@poc/core`), because the CRM API deliberately exposes no deletes.
 *
 * Endpoints default to the compose service names (`web`, `salesforce-mock`,
 * `mcp`, `worker`) because the suite runs inside the `tools` container on the
 * compose network. Set `E2E_HOST=localhost` (or the individual `E2E_*_URL`
 * variables) to run it from the host instead.
 *
 * Determinism rules:
 *  - every id/email carries a per-process `RUN` marker (`E2E<6 hex>`), so two
 *    runs never collide and each file can be executed on its own;
 *  - the mock dataset is *extended*, never replaced: the demo rows are read
 *    back from `/mock/state` and seeded again next to the E2E rows;
 *  - `cleanupE2EData()` removes only rows matching this run's marker and then
 *    restores the mock to its demo-only dataset. The demo data is never
 *    touched and `/mock/reset` is never called.
 */
import { randomBytes } from 'node:crypto';

import { query, type CdcEvent } from '@poc/core';

// --------------------------------------------------------------- endpoints

const HOST = (process.env.E2E_HOST ?? '').trim();

function serviceUrl(name: string, port: number): string {
  // Container hostnames by default; `${E2E_HOST}:port` for host-side runs.
  return `http://${HOST === '' ? name : HOST}:${port}`;
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export const WEB_URL = trimUrl(process.env.E2E_WEB_URL ?? serviceUrl('web', 3000));
export const MOCK_URL = trimUrl(process.env.E2E_MOCK_URL ?? serviceUrl('salesforce-mock', 4000));
export const MCP_URL = trimUrl(process.env.E2E_MCP_URL ?? serviceUrl('mcp', 3001));
export const WORKER_CONTROL_URL = trimUrl(
  process.env.E2E_WORKER_CONTROL_URL ?? serviceUrl('worker', 3002),
);

export const CRM_TOKEN = (process.env.CRM_API_TOKEN ?? 'poc-local-token').trim();
export const MCP_TOKEN = (process.env.MCP_AUTH_TOKEN ?? 'poc-local-token').trim();

// ------------------------------------------------------------- run marker

/** 6 hex chars, unique per vitest process; every E2E row carries it. */
export const RUN = randomBytes(3).toString('hex').toUpperCase();

const E2E_MARKER = `E2E${RUN}`;

/**
 * Salesforce-shaped 18-char id whose first 15 chars embed the run marker.
 * `tag` must keep the 15-char base unique — the constructor throws instead of
 * silently truncating (two ids truncated to the same base is a nasty test bug).
 */
export function e2eId(prefix: '001' | '003' | '006' | '00Q', tag: string): string {
  const base = `${prefix}${E2E_MARKER}${tag}`.toUpperCase();
  if (base.length > 15) {
    throw new Error(`e2eId("${prefix}", "${tag}") is ${base.length} chars; the 15-char id base would truncate`);
  }
  return `${base.padEnd(15, 'X')}AAA`;
}

/** Lower-cased unique email for this run, e.g. `e2e-a1b2c3-lead@example.test`. */
export function e2eEmail(label: string): string {
  return `e2e-${RUN.toLowerCase()}-${label}@example.test`.toLowerCase();
}

/**
 * Unique client IP per run+label, so every rate-limit bucket in the suite has
 * its own address. The third octet is a stable hash of the label (collisions
 * across the few labels used here are checked by the assertions themselves).
 */
export function e2eIp(label: string): string {
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) % 251;
  const fourth = Math.max(1, parseInt(RUN.slice(0, 2), 16));
  return `198.18.${hash + 1}.${fourth}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------- generic I/O

async function readJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} -> ${response.status}: ${text.slice(0, 400)}`);
  }
  return text.trim() === '' ? null : (JSON.parse(text) as unknown);
}

/**
 * `fetch` that retries transport errors (connection refused / reset).
 *
 * The stack runs under `tsx watch` and `next dev`: a source edit hot-restarts a
 * service, which invalidates a connection for a second or two. That is normal
 * for this POC and must not fail an assertion; HTTP *status* codes are never
 * retried here.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { attempts?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const attempts = options.attempts ?? 6;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || Date.now() >= deadline) break;
      await sleep(250);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`fetch ${url} failed`);
}

// -------------------------------------------------------------- CRM API

export interface ApiInit extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
  /** `null` sends no Authorization header (used for the 401 assertions). */
  token?: string | null;
}

/** Internal CRM API call with the bearer token (`docs/CONTRACTS.md` §4). */
export function api(path: string, init: ApiInit = {}): Promise<Response> {
  const { token = CRM_TOKEN, headers, ...rest } = init;
  const finalHeaders: Record<string, string> = {
    ...(rest.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(headers ?? {}),
  };
  if (token !== null) finalHeaders.authorization = `Bearer ${token}`;
  return fetchWithRetry(`${WEB_URL}${path}`, { ...rest, headers: finalHeaders });
}

/** Same as `api` but parses the JSON body and throws on a non-2xx status. */
export async function apiJson<T>(path: string, init: ApiInit = {}): Promise<T> {
  const response = await api(path, init);
  return (await readJson(response, `${init.method ?? 'GET'} ${path}`)) as T;
}

/** Plain page fetch (HTML). Throws with a status on failure. */
export async function page(path: string): Promise<string> {
  const response = await fetchWithRetry(`${WEB_URL}${path}`, { cache: 'no-store' });
  const html = await response.text();
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}: ${html.slice(0, 200)}`);
  return html;
}

/** Tag-stripped, entity-decoded, whitespace-collapsed text of an HTML page. */
export function plainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------------------------------------------------------ Salesforce mock

export type SfRecord = Record<string, unknown>;

export interface MockDataset {
  accounts: SfRecord[];
  contacts: SfRecord[];
  opportunities: SfRecord[];
  leads: SfRecord[];
}

export interface MockCounts {
  accounts: number;
  contacts: number;
  opportunities: number;
  leads: number;
}

export interface MockState {
  dataset: MockDataset;
  counts: MockCounts;
  events: Array<{ replayId: number; topic: string; changeType: string; recordIds?: string[] }>;
  latestReplayId: number;
  latestCommitNumber: number;
}

async function mockJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchWithRetry(`${MOCK_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return (await readJson(response, `mock ${init.method ?? 'GET'} ${path}`)) as T;
}

export function mockState(): Promise<MockState> {
  return mockJson<MockState>('/mock/state');
}

export function mockHealth(): Promise<{
  status: string;
  dataset: MockCounts;
  subscribers: number;
  latestReplayId: number;
}> {
  return mockJson('/mock/health');
}

/** Replaces the whole mock dataset — callers must pass the demo rows plus theirs. */
export function seedMock(dataset: Partial<MockDataset>): Promise<{ ok: boolean; counts: MockCounts }> {
  return mockJson('/mock/seed', { method: 'POST', body: JSON.stringify(dataset) });
}

/** Admin reset. The E2E suite intentionally never calls this at the end. */
export function resetMock(): Promise<{ ok: boolean; counts: MockCounts; events: number }> {
  return mockJson('/mock/reset', { method: 'POST', body: '{}' });
}

/** `POST /mock/disconnect` — forcibly ends the matching gRPC streams. */
export function disconnectStreams(
  topic?: string,
): Promise<{ ok: boolean; disconnected: number; subscribers: number }> {
  return mockJson('/mock/disconnect', {
    method: 'POST',
    body: JSON.stringify(topic ? { topic } : {}),
  });
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

/**
 * `POST /mock/emit` — publishes a real Avro CDC event over the real gRPC stream.
 * Put `SystemModstamp` on `record` to pin the record timestamp (used by the
 * stale-write guard test); omit it to have the mock stamp the event with "now".
 */
export function emitCdc(
  object: 'Account' | 'Contact' | 'Opportunity' | 'Lead',
  changeType: 'CREATE' | 'UPDATE' | 'DELETE' | 'UNDELETE',
  record: SfRecord,
  options: { changedFields?: string[] } = {},
): Promise<EmitResult> {
  return mockJson<EmitResult>('/mock/emit', {
    method: 'POST',
    body: JSON.stringify({ object, changeType, record, ...options }),
  });
}

/** `GET /api/crm/sync/status` — checkpoint + CDC counters (docs/CONTRACTS.md §4). */
export interface SyncCheckpoint {
  channel: string;
  replay_id: string | null;
  last_event_at: string | null;
  status: string;
  error: string | null;
  updated_at: string;
}

export interface SyncStatus {
  running: boolean;
  lastBulkRun: unknown;
  lastCdcEventAt: string | null;
  checkpoints: SyncCheckpoint[];
  counts: { cdcEvents: number; failedEvents: number; staleSkipped: number };
  lagSeconds: number | null;
}

export async function syncStatus(): Promise<SyncStatus> {
  const body = await apiJson<{ data: SyncStatus }>('/api/crm/sync/status');
  return body.data;
}

/** `GET /api/crm/sync/events` — the CDC event log (newest first). */
export async function cdcEvents(limit = 200): Promise<CdcEvent[]> {
  const body = await apiJson<{ data: CdcEvent[] }>(`/api/crm/sync/events?limit=${limit}`);
  return body.data;
}

// ------------------------------------------------------------ worker control

export interface BulkRunSummary {
  jobId: string;
  kind: 'bulk_extract';
  status: 'success' | 'failed';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totals: {
    read: number;
    applied: number;
    skipped_stale: number;
    ignored: number;
    errors: number;
  };
  objects: Array<{
    object: string;
    read: number;
    applied: number;
    skipped_stale: number;
    ignored: number;
    errors: Array<{ id: string; message: string }>;
    durationMs: number;
  }>;
}

export interface WorkerHealth {
  status: string;
  mode: string;
  busy: string | null;
  lastBulkRun: {
    syncRunId: string;
    status: 'running' | 'success' | 'failed';
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    totals: BulkRunSummary['totals'] | null;
  } | null;
}

export async function workerHealth(): Promise<WorkerHealth> {
  const deadline = Date.now() + 30_000;
  let lastError = '';
  for (;;) {
    try {
      const response = await fetch(`${WORKER_CONTROL_URL}/health`, {
        headers: { authorization: `Bearer ${CRM_TOKEN}` },
        cache: 'no-store',
      });
      return (await readJson(response, 'GET worker /health')) as WorkerHealth;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // A 401 or a bad payload is a real failure; only transport errors retry.
      if (!/fetch failed|ECONNREFUSED|ECONNRESET|socket/i.test(lastError) || Date.now() >= deadline) {
        throw error;
      }
      await sleep(300);
    }
  }
}

/**
 * `POST /run/bulk` on the worker control plane. Synchronous: a `200` means the
 * extraction finished. Connection failures (the worker is a `tsx watch`
 * process and restarts on a source change) and `409` (single-flight lock) are
 * retried rather than failing the suite.
 */
export async function bulkRun(): Promise<BulkRunSummary> {
  const deadline = Date.now() + 30_000;
  let lastError = '';
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${WORKER_CONTROL_URL}/run/bulk`, {
        method: 'POST',
        headers: { authorization: `Bearer ${CRM_TOKEN}`, 'content-type': 'application/json' },
        body: '{}',
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (Date.now() >= deadline) {
        throw new Error(`POST worker /run/bulk unreachable: ${lastError}`);
      }
      await sleep(300);
      continue;
    }
    const text = await response.text();
    if (response.status === 409 && Date.now() < deadline) {
      await sleep(300);
      continue;
    }
    if (!response.ok) throw new Error(`POST worker /run/bulk -> ${response.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text) as BulkRunSummary;
  }
}

// -------------------------------------------------------------------- MCP

let rpcId = 0;

function parseSse(body: string): unknown {
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) {
    throw new Error(`MCP response had no "data:" line: ${body.slice(0, 300)}`);
  }
  return JSON.parse(dataLines.join('\n')) as unknown;
}

export interface McpRaw {
  status: number;
  body: string;
  json: unknown;
  result: unknown;
  error: unknown;
}

/**
 * One Streamable-HTTP JSON-RPC request (`POST /mcp`), stateless: the server
 * builds a fresh McpServer per request, so no session handling is needed.
 */
export async function mcpRequest(
  method: string,
  params: unknown = {},
  init: { token?: string | null } = {},
): Promise<McpRaw> {
  rpcId += 1;
  const { token = MCP_TOKEN } = init;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;

  const response = await fetchWithRetry(`${MCP_URL}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
  });
  const body = await response.text();

  let json: any = null;
  if (body.trim() !== '') {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      // Also for error responses (401/404/…), which carry the MCP error body.
      json = JSON.parse(body);
    } else if (contentType.includes('text/event-stream')) {
      json = parseSse(body);
    }
  }
  return {
    status: response.status,
    body,
    json: json ?? null,
    result: json?.result ?? null,
    error: json?.error ?? null,
  };
}

/** JSON-RPC call that returns `result` and throws on HTTP/JSON-RPC errors. */
export async function mcp<T = unknown>(
  method: string,
  params: unknown = {},
  init: { token?: string | null } = {},
): Promise<T> {
  const raw = await mcpRequest(method, params, init);
  if (raw.status !== 200) throw new Error(`MCP ${method} -> ${raw.status}: ${raw.body.slice(0, 400)}`);
  if (raw.error) throw new Error(`MCP ${method} JSON-RPC error: ${JSON.stringify(raw.error)}`);
  return raw.result as T;
}

export interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any>;
  isError?: boolean;
}

/** `tools/call` that asserts the tool did not report `isError`. */
export async function callTool<T = any>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; data: T } & ToolCallResult> {
  const result = await mcp<ToolCallResult>('tools/call', { name, arguments: args });
  if (result.isError) {
    throw new Error(`tool ${name} failed: ${result.content.map((part) => part.text).join(' ')}`);
  }
  return {
    ...result,
    text: (result.content ?? []).map((part) => part.text).join('\n'),
    data: (result.structuredContent?.data ?? null) as T,
  };
}

// ------------------------------------------------------------------- poll

export interface PollOptions {
  timeout?: number;
  interval?: number;
  label?: string;
}

/** Poll `fn` until it returns a truthy value; throws a labelled timeout. */
export async function poll<T>(
  fn: () => Promise<T | null | undefined | false>,
  options: PollOptions = {},
): Promise<T> {
  const timeout = options.timeout ?? 15_000;
  const interval = options.interval ?? 150;
  const deadline = Date.now() + timeout;
  let lastError: unknown = null;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const value = await fn();
      if (value !== null && value !== undefined && value !== false) return value as T;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }

  const detail = lastError instanceof Error ? ` — last error: ${lastError.message}` : '';
  throw new Error(
    `poll timed out after ${timeout}ms (${attempts} attempts)${options.label ? `: ${options.label}` : ''}${detail}`,
  );
}

// ------------------------------------------------------- E2E dataset + cleanup

export interface E2EDataset {
  accounts: SfRecord[];
  contacts: SfRecord[];
  opportunities: SfRecord[];
  leads: SfRecord[];
}

export interface E2EIds {
  accounts: string[];
  contacts: string[];
  opportunities: string[];
  leads: string[];
}

/** Pristine E2E records (3 accounts, 3 contacts, 3 opportunities, 2 leads). */
export function buildE2EDataset(now = new Date().toISOString()): E2EDataset {
  const accountIds = ['A', 'B', 'C'].map((tag) => e2eId('001', tag));
  const contactIds = ['A', 'B', 'C'].map((tag) => e2eId('003', tag));
  const opportunityIds = ['A', 'B', 'C'].map((tag) => e2eId('006', tag));
  const leadIds = ['A', 'B'].map((tag) => e2eId('00Q', tag));

  const accounts: SfRecord[] = accountIds.map((Id, index) => ({
    Id,
    Name: `E2E Account ${index + 1} ${RUN}`,
    Industry: ['Residential Real Estate', 'Property Management', 'Home Builder'][index],
    Website: `https://e2e-${RUN.toLowerCase()}-${index + 1}.example.test`,
    BillingCountry: 'United States',
    OwnerName: ['Dana Whitfield', 'Marcus Lee', 'Priya Nair'][index],
    CreatedDate: now,
    LastModifiedDate: now,
    SystemModstamp: now,
    IsDeleted: false,
  }));

  const contacts: SfRecord[] = contactIds.map((Id, index) => ({
    Id,
    AccountId: accountIds[index],
    FirstName: ['Avery', 'Blake', 'Casey'][index],
    LastName: `E2E Contact ${index + 1} ${RUN}`,
    Email: e2eEmail(`sf-contact-${index + 1}`),
    Phone: `+1 415 555 01${index}${index}`,
    Title: ['Principal Broker', 'Leasing Manager', 'Site Supervisor'][index],
    LastModifiedDate: now,
    SystemModstamp: now,
    IsDeleted: false,
  }));

  const opportunities: SfRecord[] = opportunityIds.map((Id, index) => ({
    Id,
    AccountId: accountIds[index],
    Name: `E2E Opportunity ${index + 1} ${RUN}`,
    StageName: ['Prospecting', 'Proposal', 'Negotiation'][index],
    Amount: [120_000, 240_000, 360_000][index],
    CloseDate: '2026-06-30',
    OwnerName: ['Dana Whitfield', 'Marcus Lee', 'Priya Nair'][index],
    Probability: [10, 60, 80][index],
    LastModifiedDate: now,
    SystemModstamp: now,
    IsDeleted: false,
  }));

  const leads: SfRecord[] = leadIds.map((Id, index) => ({
    Id,
    FirstName: 'E2E',
    LastName: `Sf Lead ${index + 1} ${RUN}`,
    Email: e2eEmail(`sf-lead-${index + 1}`),
    Company: `E2E Company ${index + 1} ${RUN}`,
    Status: ['Open - Not Contacted', 'Working - Contacted'][index],
    LeadSource: 'Web',
    LastModifiedDate: now,
    SystemModstamp: now,
    IsDeleted: false,
  }));

  return { accounts, contacts, opportunities, leads };
}

export function e2eIds(dataset: E2EDataset): E2EIds {
  return {
    accounts: dataset.accounts.map((row) => String(row.Id)),
    contacts: dataset.contacts.map((row) => String(row.Id)),
    opportunities: dataset.opportunities.map((row) => String(row.Id)),
    leads: dataset.leads.map((row) => String(row.Id)),
  };
}

/** True for records this suite seeded (their id embeds the run marker). */
export function isE2ERecord(row: unknown): boolean {
  const id = String((row as SfRecord | null)?.Id ?? '').toUpperCase();
  return id.includes(E2E_MARKER);
}

function withoutE2ERows(rows: SfRecord[] | undefined): SfRecord[] {
  return (rows ?? []).filter((row) => !isE2ERecord(row));
}

/**
 * Seeds the E2E objects *next to* the live demo dataset.
 *
 * `/mock/seed` replaces everything, so the current demo rows are read back from
 * `/mock/state` first and seeded again unchanged. Re-running this (a second
 * test file, a second suite run) is safe: any previous E2E rows are dropped and
 * replaced by pristine copies stamped "now", which keeps the bulk extract's
 * stale-write guard from skipping them.
 */
export async function prepareE2EDataset(): Promise<E2EDataset> {
  const dataset = buildE2EDataset();
  const state = await mockState();
  await seedMock({
    accounts: [...withoutE2ERows(state.dataset.accounts), ...dataset.accounts],
    contacts: [...withoutE2ERows(state.dataset.contacts), ...dataset.contacts],
    opportunities: [...withoutE2ERows(state.dataset.opportunities), ...dataset.opportunities],
    leads: [...withoutE2ERows(state.dataset.leads), ...dataset.leads],
  });
  return dataset;
}

/** Restores the mock dataset to the demo rows only (E2E rows dropped). */
export async function restoreMockDataset(): Promise<void> {
  const state = await mockState();
  await seedMock({
    accounts: withoutE2ERows(state.dataset.accounts),
    contacts: withoutE2ERows(state.dataset.contacts),
    opportunities: withoutE2ERows(state.dataset.opportunities),
    leads: withoutE2ERows(state.dataset.leads),
  });
}

/**
 * Removes every row this run created (matched by the `E2E<RUN>` marker or the
 * run-scoped email prefix) and restores the mock to its demo dataset. Only
 * this run's rows are affected; demo data is never touched.
 */
export async function cleanupE2EData(): Promise<void> {
  const sfPattern = `%${E2E_MARKER}%`;
  const emailPattern = `e2e-${RUN.toLowerCase()}-%@example.test`;

  await query(`DELETE FROM cdc_events WHERE record_id ILIKE $1`, [sfPattern]);
  await query(
    `DELETE FROM sf_orphan_links
      WHERE account_salesforce_id ILIKE $1
         OR local_id IN (SELECT id FROM contacts WHERE salesforce_id ILIKE $1)
         OR local_id IN (SELECT id FROM opportunities WHERE salesforce_id ILIKE $1)`,
    [sfPattern],
  );
  await query(`DELETE FROM opportunities WHERE salesforce_id ILIKE $1`, [sfPattern]);
  await query(`DELETE FROM contacts WHERE salesforce_id ILIKE $1`, [sfPattern]);
  await query(`DELETE FROM leads WHERE salesforce_id ILIKE $1 OR lower(email) LIKE $2`, [
    sfPattern,
    emailPattern,
  ]);
  await query(`DELETE FROM accounts WHERE salesforce_id ILIKE $1`, [sfPattern]);

  await restoreMockDataset();
}

/** Count of live (not soft-deleted) records in the mock dataset. */
export function liveRecordCount(dataset: MockDataset): number {
  const objects: Array<keyof MockDataset> = ['accounts', 'contacts', 'opportunities', 'leads'];
  return objects.reduce(
    (total, object) => total + dataset[object].filter((row) => row.IsDeleted !== true).length,
    0,
  );
}

/** Records grouped by object, live only — matches what Bulk API returns. */
export function liveCounts(dataset: MockDataset): MockCounts {
  return {
    accounts: dataset.accounts.filter((row) => row.IsDeleted !== true).length,
    contacts: dataset.contacts.filter((row) => row.IsDeleted !== true).length,
    opportunities: dataset.opportunities.filter((row) => row.IsDeleted !== true).length,
    leads: dataset.leads.filter((row) => row.IsDeleted !== true).length,
  };
}
