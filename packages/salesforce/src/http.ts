/**
 * Thin Salesforce REST client: resolves the instance URL, attaches the bearer
 * token and retries **once** after refreshing the token when Salesforce answers
 * 401 (expired session).
 */
import { getAccessToken, getInstanceUrl, refreshAccessToken } from './auth';
import { sfApiVersion } from './config';

export class SalesforceApiError extends Error {
  status: number;
  code: string;
  body: unknown;

  constructor(message: string, status: number, code: string, body: unknown) {
    super(message);
    this.name = 'SalesforceApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface SfRequestOptions {
  /** Request body: text/CSV for bulk uploads, JSON string, or nothing. */
  body?: string | Uint8Array;
  contentType?: string;
  accept?: string;
  timeoutMs?: number;
  /** Set false to disable the 401 refresh-retry (used by the retry itself). */
  retryOn401?: boolean;
  extraHeaders?: Record<string, string>;
}

function absoluteUrl(instanceUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${instanceUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** `services/data/v62.0/...` → `/services/data/v62.0/...` (accepts both). */
export function apiPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

async function send(
  method: string,
  url: string,
  token: string,
  options: SfRequestOptions,
): Promise<Response> {
  const timeout = options.timeoutMs ?? Number(process.env.SF_HTTP_TIMEOUT_MS ?? 60_000);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: options.accept ?? 'application/json',
    ...(options.extraHeaders ?? {}),
  };
  if (options.body !== undefined && options.contentType) {
    headers['content-type'] = options.contentType;
  }
  return fetch(url, {
    method,
    headers,
    body: options.body,
    signal: AbortSignal.timeout(timeout),
  });
}

/** Raw fetch against the org. Throws only on transport errors. */
export async function sfRequest(
  method: string,
  path: string,
  options: SfRequestOptions = {},
): Promise<Response> {
  const instanceUrl = await getInstanceUrl();
  const url = absoluteUrl(instanceUrl, path);
  let token = await getAccessToken();
  let response = await send(method, url, token, options);

  if (response.status === 401 && options.retryOn401 !== false) {
    // Salesforce session expired mid-run: refresh once and replay the request.
    await response.text().catch(() => undefined);
    token = await refreshAccessToken();
    response = await send(method, url, token, { ...options, retryOn401: false });
  }
  return response;
}

function parseBody(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorFromBody(body: unknown, status: number): { code: string; message: string } {
  const first = Array.isArray(body) ? (body[0] as Record<string, unknown>) : body;
  if (first && typeof first === 'object') {
    const record = first as Record<string, unknown>;
    const code = typeof record.errorCode === 'string' ? record.errorCode : `HTTP_${status}`;
    const message =
      typeof record.message === 'string' ? record.message : JSON.stringify(first).slice(0, 300);
    return { code, message };
  }
  if (typeof body === 'string' && body.trim() !== '') {
    return { code: `HTTP_${status}`, message: body.slice(0, 300) };
  }
  return { code: `HTTP_${status}`, message: `Salesforce request failed with status ${status}` };
}

/** JSON request; throws `SalesforceApiError` for any non-2xx response. */
export async function sfJson<T = unknown>(
  method: string,
  path: string,
  options: SfRequestOptions = {},
): Promise<T> {
  const response = await sfRequest(method, path, {
    ...options,
    accept: options.accept ?? 'application/json',
  });
  const text = await response.text();
  if (!response.ok) {
    const body = parseBody(text);
    const { code, message } = errorFromBody(body, response.status);
    throw new SalesforceApiError(
      `Salesforce ${method} ${path} → ${response.status} ${code}: ${message}`,
      response.status,
      code,
      body,
    );
  }
  return parseBody(text) as T;
}

/** Text request (CSV downloads). Throws `SalesforceApiError` on failure. */
export async function sfText(
  method: string,
  path: string,
  options: SfRequestOptions = {},
): Promise<string> {
  const response = await sfRequest(method, path, {
    ...options,
    accept: options.accept ?? 'text/csv, application/json',
  });
  const text = await response.text();
  if (!response.ok) {
    const body = parseBody(text);
    const { code, message } = errorFromBody(body, response.status);
    throw new SalesforceApiError(
      `Salesforce ${method} ${path} → ${response.status} ${code}: ${message}`,
      response.status,
      code,
      body,
    );
  }
  return text;
}

/** `/services/data/v62.0/jobs/ingest` with the configured API version. */
export function dataPath(suffix: string): string {
  const version = sfApiVersion();
  return apiPath(`/services/data/${version}/${suffix.replace(/^\/+/, '')}`);
}

export function apexPath(suffix: string): string {
  return dataPath(suffix);
}
