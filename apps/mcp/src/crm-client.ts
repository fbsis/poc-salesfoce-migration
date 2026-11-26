/**
 * Thin typed HTTP client for the internal CRM API (`apps/web/app/api/crm/**`).
 *
 * CONTRACTS.md §4: every route requires `Authorization: Bearer ${CRM_API_TOKEN}`,
 * lists answer `{ data, meta }`, singles `{ data }`, errors
 * `{ error: { code, message } }`.
 *
 * Guarantees:
 *  - 8s timeout on every call (`AbortSignal.timeout`).
 *  - every failure becomes a `CrmApiError` with a `status` and a machine `code`;
 *    nothing else (stack traces, fetch internals, tokens) escapes to tool text.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH';

/** Query values are stringified; `undefined` / `null` / `''` are dropped. */
export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export interface CrmClientOptions {
  /** e.g. `http://web:3000` — a scheme is added when missing. */
  baseUrl: string;
  token: string;
  /** Default 8000ms (contract requirement). */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface CrmRequestOptions {
  query?: QueryParams;
  body?: unknown;
}

/** List envelope from the CRM API. */
export interface ListPayload<T = unknown> {
  data: T[];
  meta?: { total?: number; limit?: number; offset?: number };
}

/** Single-entity envelope from the CRM API. */
export interface EntityPayload<T = unknown> {
  data: T;
}

/**
 * Error raised for every non-2xx response, timeout, or connection failure.
 * `code` mirrors the API error code when there is one, otherwise it is a
 * stable local code (`upstream_unreachable`, `upstream_timeout`, ...).
 */
export class CrmApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CrmApiError';
    this.status = status;
    this.code = code;
  }
}

export function isCrmApiError(error: unknown): error is CrmApiError {
  return error instanceof CrmApiError;
}

const DEFAULT_TIMEOUT_MS = 8_000;

function withScheme(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function buildUrl(baseUrl: string, path: string, query?: QueryParams): URL {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, withScheme(baseUrl));
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

/** Code to use when the upstream answered with something unparseable. */
function codeForStatus(status: number): string {
  if (status === 400) return 'validation_error';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'http_error';
}

function truncate(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export class CrmClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CrmClientOptions) {
    this.baseUrl = withScheme(options.baseUrl || 'http://localhost:3000');
    this.token = options.token ?? '';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  get<T>(path: string, options: CrmRequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, body?: unknown, options: CrmRequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, { ...options, body: body ?? options.body });
  }

  patch<T>(path: string, body?: unknown, options: CrmRequestOptions = {}): Promise<T> {
    return this.request<T>('PATCH', path, { ...options, body: body ?? options.body });
  }

  /** `/health` probe: `ok` only when the CRM API answers 2xx. */
  async ping(): Promise<'ok' | 'unreachable'> {
    try {
      await this.get('/api/crm/accounts', { query: { limit: 1 } });
      return 'ok';
    } catch {
      return 'unreachable';
    }
  }

  private async request<T>(method: HttpMethod, path: string, options: CrmRequestOptions): Promise<T> {
    const url = buildUrl(this.baseUrl, path, options.query);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new CrmApiError(
          504,
          'upstream_timeout',
          `CRM API did not answer within ${this.timeoutMs}ms (${method} ${url.pathname}).`,
        );
      }
      // Never surface the raw fetch error: it can carry the full URL/host.
      throw new CrmApiError(
        503,
        'upstream_unreachable',
        `CRM API is unreachable at ${url.origin} (${method} ${url.pathname}).`,
      );
    }

    const raw = await response.text().catch(() => '');
    const payload = raw ? parseJson(raw) : undefined;

    if (!response.ok) {
      const body = payload as { error?: { code?: unknown; message?: unknown } } | undefined;
      const code =
        typeof body?.error?.code === 'string' && body.error.code.length > 0
          ? body.error.code
          : codeForStatus(response.status);
      const message =
        typeof body?.error?.message === 'string' && body.error.message.length > 0
          ? body.error.message
          : raw
            ? truncate(raw)
            : `CRM API returned HTTP ${response.status}.`;
      throw new CrmApiError(response.status, code, message);
    }

    if (payload === undefined) {
      throw new CrmApiError(
        502,
        'upstream_invalid_response',
        `CRM API returned a non-JSON body for ${method} ${url.pathname}.`,
      );
    }
    return payload as T;
  }
}

export function createCrmClientFromEnv(env: NodeJS.ProcessEnv = process.env): CrmClient {
  return new CrmClient({
    baseUrl: env.CRM_API_BASE_URL ?? 'http://localhost:3000',
    token: env.CRM_API_TOKEN ?? '',
  });
}
